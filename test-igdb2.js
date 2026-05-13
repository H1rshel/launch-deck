const IGDB_CLIENT_ID = '4pqb78li49k8uu5pbtaepjkchwdlm0';
const IGDB_CLIENT_SECRET = 'g72ypi4huy9v8ov7peukizbj081kqe';

async function testIgdb() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${IGDB_CLIENT_ID}&client_secret=${IGDB_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: 'POST' }
  );
  const token = (await res.json()).access_token;

  const queries = [
    `fields name,category; where category = 0; limit 1;`,
    `fields name,category; where category = (0); limit 1;`,
    `fields name,category; where category = 0; limit 1;`,
    `fields name,category; where category = null; limit 1;`
  ];

  for (const q of queries) {
    const igdbRes = await fetch('https://api.igdb.com/v4/games', {
      method: 'POST',
      headers: {
        'Client-ID': IGDB_CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: q,
    });
    console.log(`Query: ${q}`);
    console.log(`Result:`, await igdbRes.text());
  }
}

testIgdb();
