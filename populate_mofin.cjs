require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function main() {
  const { data, error } = await supabase
    .from('upcoming_games_cache')
    .upsert({
      source: 'igdb',
      source_game_id: '228530',
      name: 'Mofin',
      status: 'upcoming',
      release_date_precision: 'year'
    }, {
      onConflict: 'source,source_game_id'
    });

  if (error) console.error("Error:", error);
  else console.log("Success:", data);
}

main();
