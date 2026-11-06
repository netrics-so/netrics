-- #394: the kind joins the key of connection_resources. A row names a
-- resource (an app) or the value of another dimension (#374: an Apple Ads
-- campaign, kind "campaign"; #394: an ad group, kind "ad_group"). Provider
-- IDs of different kinds can be equal, and with (connection_id, resource_id)
-- as the key one discovery's ad group overwrote the campaign or app of the
-- same ID. Now each kind keeps its own name.
--
-- Existing rows: unique on (connection_id, resource_id), so unique on the
-- wider key too; none are changed. The new key keeps resource_id second,
-- so lookups by connection and resource ID still use it.
ALTER TABLE "connection_resources" DROP CONSTRAINT "connection_resources_connection_id_resource_id_pk";--> statement-breakpoint
ALTER TABLE "connection_resources" ADD CONSTRAINT "connection_resources_connection_id_resource_id_kind_pk" PRIMARY KEY("connection_id","resource_id","kind");