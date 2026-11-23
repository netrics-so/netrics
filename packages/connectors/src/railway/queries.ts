// The GraphQL documents the Railway connector sends, and the shapes of
// their answers. Every document is a query: the connector never mutates.
// A changed shape fails parsing (and the contract tests) instead of
// storing something else.

import { z } from "zod";

/** Every status of Railway's `DeploymentStatus` enum (checked 2026-11). */
export const DEPLOYMENT_STATUSES = [
  "BUILDING",
  "CRASHED",
  "DEPLOYING",
  "FAILED",
  "INITIALIZING",
  "NEEDS_APPROVAL",
  "QUEUED",
  "REMOVED",
  "REMOVING",
  "SKIPPED",
  "SLEEPING",
  "SUCCESS",
  "WAITING",
] as const;

/** Account tokens: who the token belongs to and its workspaces. */
export const ME_QUERY = `query netricsMe {
  me { workspaces { id name } }
}`;

/** Workspace tokens (and account tokens of a member): one workspace. */
export const WORKSPACE_QUERY = `query netricsWorkspace($workspaceId: String!) {
  workspace(workspaceId: $workspaceId) { id name }
}`;

/** Projects of a workspace with their services and environments, by name. */
export const PROJECTS_QUERY = `query netricsProjects($workspaceId: String!, $first: Int!, $after: String, $servicesFirst: Int!, $environmentsFirst: Int!) {
  projects(workspaceId: $workspaceId, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        name
        services(first: $servicesFirst) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name } }
        }
        environments(first: $environmentsFirst) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name isEphemeral } }
        }
      }
    }
  }
}`;

/** Further services of one project, for discovery. */
export const PROJECT_SERVICES_QUERY = `query netricsProjectServices($projectId: String!, $first: Int!, $after: String) {
  project(id: $projectId) {
    id
    services(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name } }
    }
  }
}`;

/** Further environments of one project (PR environments too), for discovery. */
export const PROJECT_ENVIRONMENTS_QUERY = `query netricsProjectEnvironments($projectId: String!, $first: Int!, $after: String) {
  project(id: $projectId) {
    id
    environments(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { id name isEphemeral } }
    }
  }
}`;

const SERVICE_INSTANCE_FIELDS = `pageInfo { hasNextPage endCursor }
            edges {
              node {
                serviceId
                serviceName
                environmentId
                latestDeployment { id status createdAt statusUpdatedAt }
                activeDeployments { id status }
              }
            }`;

/**
 * One page of a project's lasting environments (PR environments are left
 * out by Railway, `isEphemeral: false`) with the first page of each one's
 * service instances. An environment with more instances continues with
 * ENVIRONMENT_INSTANCES_QUERY.
 */
export const PROJECT_STATE_QUERY = `query netricsProjectState($projectId: String!, $envFirst: Int!, $envAfter: String, $instFirst: Int!, $ephemeral: Boolean!) {
  project(id: $projectId) {
    id
    name
    environments(first: $envFirst, after: $envAfter, isEphemeral: $ephemeral) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          isEphemeral
          serviceInstances(first: $instFirst) {
            ${SERVICE_INSTANCE_FIELDS}
          }
        }
      }
    }
  }
}`;

/** The next page of one environment's service instances. */
export const ENVIRONMENT_INSTANCES_QUERY = `query netricsEnvironmentInstances($environmentId: String!, $projectId: String!, $first: Int!, $after: String) {
  environment(id: $environmentId, projectId: $projectId) {
    id
    serviceInstances(first: $first, after: $after) {
      ${SERVICE_INSTANCE_FIELDS}
    }
  }
}`;

/** Deployments of one project, newest first, a page at a time. */
export const DEPLOYMENTS_QUERY = `query netricsDeployments($projectId: String!, $first: Int!, $after: String) {
  deployments(input: { projectId: $projectId }, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        status
        createdAt
        updatedAt
        statusUpdatedAt
        serviceId
        environmentId
        projectId
      }
    }
  }
}`;

/** Measured usage of a workspace between two instants, per project. */
export const USAGE_QUERY = `query netricsUsage($workspaceId: String!, $measurements: [MetricMeasurement!]!, $startDate: DateTime!, $endDate: DateTime!) {
  usage(workspaceId: $workspaceId, measurements: $measurements, startDate: $startDate, endDate: $endDate, groupBy: [PROJECT_ID]) {
    measurement
    value
    tags { projectId }
  }
}`;

/** Railway's estimate of a workspace's usage at the end of its billing period. */
export const ESTIMATED_USAGE_QUERY = `query netricsEstimatedUsage($workspaceId: String!, $measurements: [MetricMeasurement!]!) {
  estimatedUsage(workspaceId: $workspaceId, measurements: $measurements) {
    measurement
    estimatedValue
    projectId
  }
}`;

export const ALL_QUERIES = [
  ME_QUERY,
  WORKSPACE_QUERY,
  PROJECTS_QUERY,
  PROJECT_SERVICES_QUERY,
  PROJECT_ENVIRONMENTS_QUERY,
  PROJECT_STATE_QUERY,
  ENVIRONMENT_INSTANCES_QUERY,
  DEPLOYMENTS_QUERY,
  USAGE_QUERY,
  ESTIMATED_USAGE_QUERY,
] as const;

// ─── Answer shapes ──────────────────────────────────────────────────────────

const id = z.string().min(1);
const instant = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullish(),
});
const connection = <T extends z.ZodType>(node: T) =>
  z.object({ pageInfo, edges: z.array(z.object({ node })) });

export const workspaceSchema = z.object({ id, name: z.string() });
export const meSchema = z.object({
  me: z.object({ workspaces: z.array(workspaceSchema) }),
});
export const workspaceAnswerSchema = z.object({ workspace: workspaceSchema });

const namedSchema = z.object({ id, name: z.string() });
const environmentSchema = namedSchema.extend({
  isEphemeral: z.boolean().nullish(),
});

export const projectsSchema = z.object({
  projects: z.object({
    pageInfo,
    edges: z.array(
      z.object({
        node: z.object({
          id,
          name: z.string(),
          services: connection(namedSchema),
          environments: connection(environmentSchema),
        }),
      }),
    ),
  }),
});

export const projectServicesSchema = z.object({
  project: z.object({ id, services: connection(namedSchema) }),
});

export const projectEnvironmentsSchema = z.object({
  project: z.object({ id, environments: connection(environmentSchema) }),
});

const statusSchema = z.enum(DEPLOYMENT_STATUSES);
/**
 * A status this connector does not know yet (Railway adds enum values as
 * an additive change) is kept as Railway's text rather than failing a sync.
 */
const deploymentStatus = z.union([statusSchema, z.string().min(1)]);

const serviceInstanceSchema = z.object({
  serviceId: id,
  serviceName: z.string().nullish(),
  environmentId: id,
  latestDeployment: z
    .object({
      id,
      status: deploymentStatus,
      createdAt: instant,
      statusUpdatedAt: instant.nullish(),
    })
    .nullish(),
  activeDeployments: z
    .array(z.object({ id, status: deploymentStatus }))
    .nullish(),
});
export type RailwayServiceInstance = z.infer<typeof serviceInstanceSchema>;

const serviceInstancesSchema = z.object({
  pageInfo,
  edges: z.array(z.object({ node: serviceInstanceSchema })),
});

export const projectStateSchema = z.object({
  project: z.object({
    id,
    name: z.string(),
    environments: z.object({
      pageInfo,
      edges: z.array(
        z.object({
          node: environmentSchema.extend({
            serviceInstances: serviceInstancesSchema,
          }),
        }),
      ),
    }),
  }),
});

export const environmentInstancesSchema = z.object({
  environment: z.object({ id, serviceInstances: serviceInstancesSchema }),
});

export const deploymentSchema = z.object({
  id,
  status: deploymentStatus,
  createdAt: instant,
  updatedAt: instant.nullish(),
  statusUpdatedAt: instant.nullish(),
  serviceId: z.string().nullish(),
  environmentId: id,
  projectId: id,
});
export type RailwayDeployment = z.infer<typeof deploymentSchema>;

export const deploymentsSchema = z.object({
  deployments: z.object({
    pageInfo,
    edges: z.array(z.object({ node: deploymentSchema })),
  }),
});

export const usageSchema = z.object({
  usage: z.array(
    z.object({
      measurement: z.string(),
      value: z.number(),
      tags: z.object({ projectId: z.string().nullish() }),
    }),
  ),
});

export const estimatedUsageSchema = z.object({
  estimatedUsage: z.array(
    z.object({
      measurement: z.string(),
      estimatedValue: z.number(),
      projectId: z.string().nullish(),
    }),
  ),
});
