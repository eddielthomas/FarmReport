-- =============================================================================
-- 169_customer_default_basemap.sql — customer portal default map theme.
-- -----------------------------------------------------------------------------
-- The customer console (Figma "S-v1") renders its default map on a light street
-- theme (CARTO Positron), not satellite. Each project's DEFAULT scene drives the
-- initial hero map, so point every default (is_default) scene that's still on
-- the old 'satellite' default at the brand 'deepgrid' basemap (tile=streets,
-- no recolor filter) so the portal opens on the Figma theme.
--
-- Alternate scenes (SAR survey / thermal close-up) keep their analytic basemaps;
-- the Map Detail tab still lets customers switch to satellite/HydroVision/etc.
-- Strictly additive + idempotent.
-- =============================================================================

UPDATE crm.project_scene
   SET basemap_id = 'deepgrid', updated_at = now()
 WHERE is_default = true
   AND (basemap_id IS NULL OR basemap_id = 'satellite');
