const tokenUrl = `https://id.twitch.tv/oauth2/token?client_id=${process.env.IGDB_CLIENT_ID}&client_secret=${process.env.IGDB_CLIENT_SECRET}&grant_type=client_credentials`;
fetch(tokenUrl, { method: 'POST' }).then(r=>r.json()).then(async ({access_token}) => {
  const q = `
    fields id, name, category, hypes, first_release_date, release_dates.date;
    where first_release_date >= 1713500000 
      & first_release_date <= 1735600000
      & (status = null | (status != 6 & status != 8))
      & cover != null
      & (category = null | category = 0 | category = 8 | category = 9 | category = 10);
    sort first_release_date asc;
    limit 10;
  `;
  const res = await fetch('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': process.env.IGDB_CLIENT_ID,
      'Authorization': 'Bearer ' + access_token,
      'Content-Type': 'text/plain'
    },
    body: q
  });
  console.log('Status', res.status);
  console.log(await res.text());
});
