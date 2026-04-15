-- Add course data columns to races for accurate predictions.
-- elevation_gain_feet: total gain (not net) in feet
-- elevation_loss_feet: total loss (descent) in feet
-- race_altitude_ft: start/peak altitude in feet (for altitude penalty above 5,000ft)
-- trail_subtype: 'groomed' | 'mixed' | 'technical' | 'highly_technical'
--   groomed = well-maintained trail (fire roads, groomed singletrack)
--   mixed = mix of dirt, rocks, and moderate roots
--   technical = rocky, rooty, exposed ridges, challenging footing
--   highly_technical = extreme scrambling, sustained technical terrain

ALTER TABLE races ADD COLUMN IF NOT EXISTS elevation_gain_feet float;
ALTER TABLE races ADD COLUMN IF NOT EXISTS elevation_loss_feet float;
ALTER TABLE races ADD COLUMN IF NOT EXISTS race_altitude_ft float;
ALTER TABLE races ADD COLUMN IF NOT EXISTS trail_subtype text CHECK (trail_subtype IN ('groomed', 'mixed', 'technical', 'highly_technical'));
