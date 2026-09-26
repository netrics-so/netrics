import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  activeProjectResponseSchema,
  addMemberRequestSchema,
  auditEventListResponseSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
  errorResponseSchema,
  memberListResponseSchema,
  memberResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  renameProjectRequestSchema,
  renameWorkspaceRequestSchema,
  setActiveProjectRequestSchema,
  updateMemberRoleRequestSchema,
  workspaceListResponseSchema,
  workspaceResponseSchema,
  workspaceRoleSchema,
  type WorkspaceRole,
} from "@netrics/contracts";
import {
  addMembership,
  createProject,
  createWorkspaceWithOwner,
  deleteMembership,
  deleteProject,
  findMembership,
  findProject,
  findUserByEmail,
  findWorkspace,
  insertAuditEvent,
  isDuplicateMembershipError,
  isLastOwnerError,
  listAuditEvents,
  listMembers,
  listMembershipsForUser,
  listProjects,
  renameProject,
  renameWorkspace,
  setActiveProject,
  updateMembershipRole,
  withUserContext,
  withWorkspace,
  type Database,
  type MemberDetails,
  type Project,
  type Workspace,
} from "@netrics/database";
import { can, canManageMember } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { createRequireSession } from "./session.js";

export interface WorkspaceRouteDeps {
  authService: AuthService;
  db: Database;
}

function sendError(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send(errorResponseSchema.parse({ error }));
}

function parseBody<T>(
  schema: z.ZodType<T>,
  request: FastifyRequest,
  reply: FastifyReply,
): T | null {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    sendError(reply, 400, "invalid_request");
    return null;
  }
  return parsed.data;
}

interface WorkspaceAccess {
  workspaceId: string;
  callerId: string;
  role: WorkspaceRole;
}

const workspaceParamsSchema = z.object({ workspaceId: z.uuid() });
const memberParamsSchema = z.object({ userId: z.uuid() });
const projectParamsSchema = z.object({ projectId: z.uuid() });

/**
 * Resolves the caller's membership for the :workspaceId route param. The
 * workspace id comes from the URL but is never trusted: the membership lookup
 * runs under the caller's user context, and a missing membership yields 404
 * (not 403) so workspace existence is not leaked to non-members.
 */
async function resolveAccess(
  db: Database,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<WorkspaceAccess | null> {
  const params = workspaceParamsSchema.safeParse(request.params);
  if (!params.success) {
    sendError(reply, 404, "workspace_not_found");
    return null;
  }
  const callerId = request.sessionIdentity!.domainUserId;
  const membership = await withUserContext(db, { userId: callerId }, (tx) =>
    findMembership(tx, params.data.workspaceId, callerId),
  );
  if (!membership) {
    sendError(reply, 404, "workspace_not_found");
    return null;
  }
  return {
    workspaceId: params.data.workspaceId,
    callerId,
    role: workspaceRoleSchema.parse(membership.role),
  };
}

function toWorkspace(workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt.toISOString(),
  };
}

function toMember(member: MemberDetails) {
  return {
    id: member.id,
    userId: member.userId,
    email: member.email,
    displayName: member.displayName,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
  };
}

function toProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
  };
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  deps: WorkspaceRouteDeps,
): void {
  const requireSession = createRequireSession(deps.authService);

  void app.register(
    (scope, _opts, done) => {
      scope.addHook("preHandler", requireSession);

      scope.post("/workspaces", async (request, reply) => {
        const body = parseBody(createWorkspaceRequestSchema, request, reply);
        if (!body) {
          return;
        }
        const workspace = await createWorkspaceWithOwner(deps.db, {
          name: body.name,
          ownerUserId: request.sessionIdentity!.domainUserId,
        });
        return workspaceResponseSchema.parse({
          workspace: toWorkspace(workspace),
        });
      });

      scope.get("/workspaces", async (request) => {
        const callerId = request.sessionIdentity!.domainUserId;
        const memberships = await listMembershipsForUser(deps.db, callerId);
        return workspaceListResponseSchema.parse({
          workspaces: memberships.map((membership) => ({
            id: membership.workspaceId,
            name: membership.workspaceName,
            role: membership.role,
            activeProjectId: membership.activeProjectId,
          })),
        });
      });

      scope.get("/workspaces/:workspaceId", async (request, reply) => {
        const access = await resolveAccess(deps.db, request, reply);
        if (!access) {
          return;
        }
        const workspace = await withWorkspace(
          deps.db,
          { workspaceId: access.workspaceId, userId: access.callerId },
          (tx) => findWorkspace(tx, access.workspaceId),
        );
        if (!workspace) {
          return sendError(reply, 404, "workspace_not_found");
        }
        return workspaceResponseSchema.parse({
          workspace: toWorkspace(workspace),
        });
      });

      scope.patch("/workspaces/:workspaceId", async (request, reply) => {
        const access = await resolveAccess(deps.db, request, reply);
        if (!access) {
          return;
        }
        if (!can(access.role, "workspace:rename")) {
          return sendError(reply, 403, "forbidden");
        }
        const body = parseBody(renameWorkspaceRequestSchema, request, reply);
        if (!body) {
          return;
        }
        const workspace = await withWorkspace(
          deps.db,
          { workspaceId: access.workspaceId, userId: access.callerId },
          async (tx) => {
            const current = await findWorkspace(tx, access.workspaceId);
            if (!current) {
              return null;
            }
            const renamed = await renameWorkspace(
              tx,
              access.workspaceId,
              body.name,
            );
            await insertAuditEvent(tx, {
              workspaceId: access.workspaceId,
              actorUserId: access.callerId,
              action: "workspace.renamed",
              target: access.workspaceId,
              metadata: { oldName: current.name, newName: body.name },
            });
            return renamed;
          },
        );
        if (!workspace) {
          return sendError(reply, 404, "workspace_not_found");
        }
        return workspaceResponseSchema.parse({
          workspace: toWorkspace(workspace),
        });
      });

      scope.get("/workspaces/:workspaceId/members", async (request, reply) => {
        const access = await resolveAccess(deps.db, request, reply);
        if (!access) {
          return;
        }
        const members = await withWorkspace(
          deps.db,
          { workspaceId: access.workspaceId, userId: access.callerId },
          (tx) => listMembers(tx, access.workspaceId),
        );
        return memberListResponseSchema.parse({
          members: members.map(toMember),
        });
      });

      scope.post("/workspaces/:workspaceId/members", async (request, reply) => {
        const access = await resolveAccess(deps.db, request, reply);
        if (!access) {
          return;
        }
        if (!can(access.role, "members:add")) {
          return sendError(reply, 403, "forbidden");
        }
        const body = parseBody(addMemberRequestSchema, request, reply);
        if (!body) {
          return;
        }
        if (!canManageMember(access.role, body.role, "add")) {
          return sendError(reply, 403, "forbidden");
        }
        // Members are added directly by email (invitations land in milestone
        // 14); users is installation-level, so no tenant context here.
        const user = await findUserByEmail(deps.db, body.email);
        if (!user) {
          return sendError(reply, 404, "user_not_found");
        }
        try {
          const membership = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const created = await addMembership(tx, {
                workspaceId: access.workspaceId,
                userId: user.id,
                role: body.role,
              });
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "membership.added",
                target: user.id,
                metadata: { role: body.role, email: user.email },
              });
              return created;
            },
          );
          return memberResponseSchema.parse({
            member: toMember({
              id: membership.id,
              userId: user.id,
              email: user.email,
              displayName: user.displayName,
              role: membership.role,
              createdAt: membership.createdAt,
            }),
          });
        } catch (error) {
          if (isDuplicateMembershipError(error)) {
            return sendError(reply, 409, "membership_exists");
          }
          throw error;
        }
      });

      scope.patch(
        "/workspaces/:workspaceId/members/:userId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          const params = memberParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "member_not_found");
          }
          const body = parseBody(updateMemberRoleRequestSchema, request, reply);
          if (!body) {
            return;
          }
          try {
            const membership = await withWorkspace(
              deps.db,
              { workspaceId: access.workspaceId, userId: access.callerId },
              async (tx) => {
                const target = await findMembership(
                  tx,
                  access.workspaceId,
                  params.data.userId,
                );
                if (!target) {
                  sendError(reply, 404, "member_not_found");
                  return null;
                }
                const targetRole = workspaceRoleSchema.parse(target.role);
                if (
                  !canManageMember(
                    access.role,
                    targetRole,
                    "change-role",
                    body.role,
                  )
                ) {
                  sendError(reply, 403, "forbidden");
                  return null;
                }
                const updated = await updateMembershipRole(tx, {
                  workspaceId: access.workspaceId,
                  userId: params.data.userId,
                  role: body.role,
                });
                if (!updated) {
                  sendError(reply, 404, "member_not_found");
                  return null;
                }
                await insertAuditEvent(tx, {
                  workspaceId: access.workspaceId,
                  actorUserId: access.callerId,
                  action: "membership.role_changed",
                  target: params.data.userId,
                  metadata: { oldRole: targetRole, newRole: body.role },
                });
                return updated;
              },
            );
            if (!membership) {
              return;
            }
            const members = await withWorkspace(
              deps.db,
              { workspaceId: access.workspaceId, userId: access.callerId },
              (tx) => listMembers(tx, access.workspaceId),
            );
            const member = members.find((m) => m.userId === params.data.userId);
            if (!member) {
              return sendError(reply, 404, "member_not_found");
            }
            return memberResponseSchema.parse({ member: toMember(member) });
          } catch (error) {
            if (isLastOwnerError(error)) {
              return sendError(reply, 409, "last_owner");
            }
            throw error;
          }
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/members/:userId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          const params = memberParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "member_not_found");
          }
          const isSelf = params.data.userId === access.callerId;
          try {
            const removed = await withWorkspace(
              deps.db,
              { workspaceId: access.workspaceId, userId: access.callerId },
              async (tx) => {
                const target = await findMembership(
                  tx,
                  access.workspaceId,
                  params.data.userId,
                );
                if (!target) {
                  sendError(reply, 404, "member_not_found");
                  return false;
                }
                if (
                  !isSelf &&
                  !canManageMember(
                    access.role,
                    workspaceRoleSchema.parse(target.role),
                    "remove",
                  )
                ) {
                  sendError(reply, 403, "forbidden");
                  return false;
                }
                await deleteMembership(tx, {
                  workspaceId: access.workspaceId,
                  userId: params.data.userId,
                });
                await insertAuditEvent(tx, {
                  workspaceId: access.workspaceId,
                  actorUserId: access.callerId,
                  action: "membership.removed",
                  target: params.data.userId,
                  metadata: { role: target.role, self: isSelf },
                });
                return true;
              },
            );
            if (!removed) {
              return;
            }
            return reply.code(204).send();
          } catch (error) {
            if (isLastOwnerError(error)) {
              return sendError(reply, 409, "last_owner");
            }
            throw error;
          }
        },
      );

      scope.patch(
        "/workspaces/:workspaceId/active-project",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          const body = parseBody(setActiveProjectRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const applied = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              // RLS scopes the lookup to this workspace, so a project id from
              // another workspace simply does not exist here.
              if (body.projectId !== null) {
                const project = await findProject(
                  tx,
                  access.workspaceId,
                  body.projectId,
                );
                if (!project) {
                  sendError(reply, 404, "project_not_found");
                  return false;
                }
              }
              await setActiveProject(tx, {
                workspaceId: access.workspaceId,
                userId: access.callerId,
                projectId: body.projectId,
              });
              return true;
            },
          );
          if (!applied) {
            return;
          }
          return activeProjectResponseSchema.parse({
            activeProjectId: body.projectId,
          });
        },
      );

      scope.post(
        "/workspaces/:workspaceId/projects",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "projects:create")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(createProjectRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const project = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const created = await createProject(tx, {
                workspaceId: access.workspaceId,
                name: body.name,
              });
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "project.created",
                target: created.id,
                metadata: { name: created.name },
              });
              return created;
            },
          );
          return projectResponseSchema.parse({ project: toProject(project) });
        },
      );

      scope.get("/workspaces/:workspaceId/projects", async (request, reply) => {
        const access = await resolveAccess(deps.db, request, reply);
        if (!access) {
          return;
        }
        const projects = await withWorkspace(
          deps.db,
          { workspaceId: access.workspaceId, userId: access.callerId },
          (tx) => listProjects(tx, access.workspaceId),
        );
        return projectListResponseSchema.parse({
          projects: projects.map(toProject),
        });
      });

      scope.patch(
        "/workspaces/:workspaceId/projects/:projectId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          const params = projectParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "project_not_found");
          }
          if (!can(access.role, "projects:rename")) {
            return sendError(reply, 403, "forbidden");
          }
          const body = parseBody(renameProjectRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const project = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const current = await findProject(
                tx,
                access.workspaceId,
                params.data.projectId,
              );
              if (!current) {
                sendError(reply, 404, "project_not_found");
                return null;
              }
              const renamed = await renameProject(tx, {
                workspaceId: access.workspaceId,
                projectId: params.data.projectId,
                name: body.name,
              });
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "project.renamed",
                target: params.data.projectId,
                metadata: { oldName: current.name, newName: body.name },
              });
              return renamed;
            },
          );
          if (!project) {
            return;
          }
          return projectResponseSchema.parse({ project: toProject(project) });
        },
      );

      scope.delete(
        "/workspaces/:workspaceId/projects/:projectId",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          const params = projectParamsSchema.safeParse(request.params);
          if (!params.success) {
            return sendError(reply, 404, "project_not_found");
          }
          if (!can(access.role, "projects:delete")) {
            return sendError(reply, 403, "forbidden");
          }
          const removed = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (tx) => {
              const current = await findProject(
                tx,
                access.workspaceId,
                params.data.projectId,
              );
              if (!current) {
                sendError(reply, 404, "project_not_found");
                return false;
              }
              await deleteProject(tx, {
                workspaceId: access.workspaceId,
                projectId: params.data.projectId,
              });
              await insertAuditEvent(tx, {
                workspaceId: access.workspaceId,
                actorUserId: access.callerId,
                action: "project.deleted",
                target: params.data.projectId,
                metadata: { name: current.name },
              });
              return true;
            },
          );
          if (!removed) {
            return;
          }
          return reply.code(204).send();
        },
      );

      scope.get(
        "/workspaces/:workspaceId/audit-events",
        async (request, reply) => {
          const access = await resolveAccess(deps.db, request, reply);
          if (!access) {
            return;
          }
          if (!can(access.role, "audit:view")) {
            return sendError(reply, 403, "forbidden");
          }
          const events = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            (tx) => listAuditEvents(tx, access.workspaceId),
          );
          return auditEventListResponseSchema.parse({
            events: events.map((event) => ({
              id: event.id,
              action: event.action,
              actorUserId: event.actorUserId,
              target: event.target,
              metadata: event.metadata as Record<string, unknown>,
              createdAt: event.createdAt.toISOString(),
            })),
          });
        },
      );

      done();
    },
    { prefix: "/v1" },
  );
}
