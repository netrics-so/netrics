import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  activeProjectResponseSchema,
  auditEventListResponseSchema,
  createProjectRequestSchema,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
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
} from "@netrics/contracts";
import {
  createProject,
  createWorkspaceWithOwner,
  deleteMembership,
  deleteProject,
  findMembership,
  findProject,
  findWorkspace,
  insertAuditEvent,
  isLastOwnerError,
  listAuditEvents,
  listMembers,
  listMembershipsForUser,
  listProjects,
  renameProject,
  updateWorkspace,
  setActiveProject,
  updateMembershipRole,
  withWorkspace,
  type Database,
  type MemberDetails,
  type Project,
  type Workspace,
} from "@netrics/database";
import { can, canManageMember } from "@netrics/domain";

import type { AuthService } from "../auth/index.js";
import { conversionOptions } from "../metrics/query.js";
import type { AddDemoContent } from "../onboarding.js";
import { parseBody, resolveAccess, sendError } from "./access.js";
import { routeSchema } from "./openapi.js";
import { createRequireSession } from "./session.js";

export interface WorkspaceRouteDeps {
  authService: AuthService;
  db: Database;
  /** Demo connection and dashboard for new workspaces (#51). */
  addDemoContent?: AddDemoContent;
  /** NETRICS_EXCHANGE_RATES: whether a display currency can be set (#191). */
  exchangeRates?: boolean;
}

const memberParamsSchema = z.object({ userId: z.uuid() });
const projectParamsSchema = z.object({ projectId: z.uuid() });

function toWorkspace(workspace: Workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    timeZone: workspace.timeZone,
    displayCurrency: workspace.displayCurrency,
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
      // onRequest: authentication precedes body validation.
      scope.addHook("onRequest", requireSession);

      scope.post(
        "/workspaces",
        {
          schema: routeSchema({
            summary: "Create a workspace",
            tags: ["workspaces"],
            body: createWorkspaceRequestSchema,
            response: createWorkspaceResponseSchema,
          }),
        },
        async (request, reply) => {
          const body = parseBody(createWorkspaceRequestSchema, request, reply);
          if (!body) {
            return;
          }
          const callerId = request.sessionIdentity!.domainUserId;
          const workspace = await createWorkspaceWithOwner(deps.db, {
            name: body.name,
            ownerUserId: callerId,
            ...(body.timeZone ? { timeZone: body.timeZone } : {}),
          });
          // The workspace exists either way; demo content is a bonus that
          // must not fail its creation.
          let demoDashboardId: string | null = null;
          if (body.withDemo && deps.addDemoContent) {
            try {
              demoDashboardId = await deps.addDemoContent({
                workspaceId: workspace.id,
                callerId,
              });
            } catch (error) {
              request.log.error(
                { err: error, workspaceId: workspace.id },
                "demo content failed",
              );
            }
          }
          return createWorkspaceResponseSchema.parse({
            workspace: toWorkspace(workspace),
            demoDashboardId,
          });
        },
      );

      scope.get(
        "/workspaces",
        {
          schema: routeSchema({
            summary: "List the caller's workspaces",
            tags: ["workspaces"],
            response: workspaceListResponseSchema,
          }),
        },
        async (request) => {
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
        },
      );

      scope.get(
        "/workspaces/:workspaceId",
        {
          schema: routeSchema({
            summary: "Get a workspace",
            tags: ["workspaces"],
            response: workspaceResponseSchema,
            errors: [404],
          }),
        },
        async (request, reply) => {
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
        },
      );

      scope.patch(
        "/workspaces/:workspaceId",
        {
          schema: routeSchema({
            summary:
              "Rename a workspace, or change its time zone or display currency",
            tags: ["workspaces"],
            body: renameWorkspaceRequestSchema,
            response: workspaceResponseSchema,
            errors: [400, 403, 404],
          }),
        },
        async (request, reply) => {
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
          const displayCurrency = body.displayCurrency;
          const outcome = await withWorkspace(
            deps.db,
            { workspaceId: access.workspaceId, userId: access.callerId },
            async (
              tx,
            ): Promise<{
              error?: 404 | "currency_conversion_off" | "currency_not_covered";
              workspace?: Workspace | null;
            }> => {
              const current = await findWorkspace(tx, access.workspaceId);
              if (!current) {
                return { error: 404 };
              }
              // EUR or a currency with ECB rates, on an instance that
              // fetches them (#191).
              if (displayCurrency) {
                if (!deps.exchangeRates) {
                  return { error: "currency_conversion_off" };
                }
                const options = await conversionOptions(tx, true);
                if (!options.currencies.includes(displayCurrency)) {
                  return { error: "currency_not_covered" };
                }
              }
              const updated = await updateWorkspace(tx, access.workspaceId, {
                ...(body.name !== undefined ? { name: body.name } : {}),
                ...(body.timeZone !== undefined
                  ? { timeZone: body.timeZone }
                  : {}),
                ...(displayCurrency !== undefined ? { displayCurrency } : {}),
              });
              if (body.name !== undefined) {
                await insertAuditEvent(tx, {
                  workspaceId: access.workspaceId,
                  actorUserId: access.callerId,
                  action: "workspace.renamed",
                  target: access.workspaceId,
                  metadata: { oldName: current.name, newName: body.name },
                });
              }
              if (body.timeZone !== undefined) {
                await insertAuditEvent(tx, {
                  workspaceId: access.workspaceId,
                  actorUserId: access.callerId,
                  action: "workspace.time_zone_changed",
                  target: access.workspaceId,
                  metadata: {
                    oldTimeZone: current.timeZone,
                    newTimeZone: body.timeZone,
                  },
                });
              }
              if (
                displayCurrency !== undefined &&
                displayCurrency !== current.displayCurrency
              ) {
                await insertAuditEvent(tx, {
                  workspaceId: access.workspaceId,
                  actorUserId: access.callerId,
                  action: "workspace.display_currency_changed",
                  target: access.workspaceId,
                  metadata: {
                    oldDisplayCurrency: current.displayCurrency,
                    newDisplayCurrency: displayCurrency,
                  },
                });
              }
              return { workspace: updated };
            },
          );
          if (outcome.error === 404) {
            return sendError(reply, 404, "workspace_not_found");
          }
          if (outcome.error) {
            return sendError(reply, 400, outcome.error);
          }
          const { workspace } = outcome;
          if (!workspace) {
            return sendError(reply, 404, "workspace_not_found");
          }
          return workspaceResponseSchema.parse({
            workspace: toWorkspace(workspace),
          });
        },
      );

      scope.get(
        "/workspaces/:workspaceId/members",
        {
          schema: routeSchema({
            summary: "List members",
            tags: ["members"],
            response: memberListResponseSchema,
            errors: [404],
          }),
        },
        async (request, reply) => {
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
        },
      );

      // Members join through invitations (routes/invitations.ts): adding an
      // existing account directly by email would grant access without any
      // proof that the invitee controls that address.

      scope.patch(
        "/workspaces/:workspaceId/members/:userId",
        {
          schema: routeSchema({
            summary: "Change a member's role",
            tags: ["members"],
            body: updateMemberRoleRequestSchema,
            response: memberResponseSchema,
            errors: [403, 404, 409],
          }),
        },
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
        {
          schema: routeSchema({
            summary: "Remove a member (or leave)",
            tags: ["members"],
            errors: [403, 404, 409],
          }),
        },
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
        {
          schema: routeSchema({
            summary: "Set the caller's active project",
            tags: ["projects"],
            body: setActiveProjectRequestSchema,
            response: activeProjectResponseSchema,
            errors: [404],
          }),
        },
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
        {
          schema: routeSchema({
            summary: "Create a project",
            tags: ["projects"],
            body: createProjectRequestSchema,
            response: projectResponseSchema,
            errors: [403, 404],
          }),
        },
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

      scope.get(
        "/workspaces/:workspaceId/projects",
        {
          schema: routeSchema({
            summary: "List projects",
            tags: ["projects"],
            response: projectListResponseSchema,
            errors: [404],
          }),
        },
        async (request, reply) => {
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
        },
      );

      scope.patch(
        "/workspaces/:workspaceId/projects/:projectId",
        {
          schema: routeSchema({
            summary: "Rename a project",
            tags: ["projects"],
            body: renameProjectRequestSchema,
            response: projectResponseSchema,
            errors: [403, 404],
          }),
        },
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
        {
          schema: routeSchema({
            summary: "Delete a project",
            tags: ["projects"],
            errors: [403, 404],
          }),
        },
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
        {
          schema: routeSchema({
            summary: "Workspace audit log",
            tags: ["workspaces"],
            response: auditEventListResponseSchema,
            errors: [403, 404],
          }),
        },
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
