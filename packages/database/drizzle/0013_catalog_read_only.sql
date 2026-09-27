-- #36: the connector catalog (connectors, metric_definitions) is written only
-- by `migrate` as the owner role, from the connector bundle of the deployed
-- image. Tenant code paths may read it but never rewrite installation-wide
-- rows, and syncs no longer lock the shared connector row.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "connectors", "metric_definitions" FROM netrics_app;
