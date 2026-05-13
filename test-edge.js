const url = 'https://aqoqmrcxjltwtojpgpan.supabase.co/functions/v1/get-discover-feeds';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxb3FtcmN4amx0d3RvanBncGFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTY1MTgsImV4cCI6MjA4ODgzMjUxOH0.o-afZOvtCi40Lbre8MD7cQ1s9dAhbiLDcdzXtCeBPZg';

async function test() {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ feed: 'top_100', page: 1, page_size: 48 })
  });

  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Response:', text);
}

test();
