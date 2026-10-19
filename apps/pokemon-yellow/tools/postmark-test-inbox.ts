/** Production QA only: inspect messages addressed to our unique Postmark blackhole test accounts. */
export async function postmarkTestLink(email: string, kind: string, origin: string): Promise<string> {
  if (!/^pokemon-qa-[a-f0-9-]+@blackhole\.postmarkapp\.com$/.test(email) || origin !== 'https://pokemon-yellow.jonaylor.com') {
    throw new Error('Production QA may only inspect its own blackhole recipients.');
  }
  const token = process.env.POSTMARK_SERVER_TOKEN;
  if (!token || token === 'POSTMARK_API_TEST') throw new Error('Production QA requires a real Postmark token in the process environment.');
  const get = async (path: string) => {
    const response = await fetch('https://api.postmarkapp.com' + path, {
      headers: { 'X-Postmark-Server-Token': token, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Postmark QA inbox failed (${response.status}).`);
    return response.json();
  };
  for (let attempt = 0; attempt < 60; attempt++) {
    const query = new URLSearchParams({ recipient: email, count: '10', offset: '0', messagestream: 'outbound' });
    const result = await get('/messages/outbound?' + query);
    const message = result.Messages?.find((row: { Subject: string }) => row.Subject.includes(kind));
    if (message) {
      const detail = await get('/messages/outbound/' + encodeURIComponent(message.MessageID) + '/details');
      if (!detail.To?.some((recipient: { Email: string }) => recipient.Email.toLowerCase() === email)) throw new Error('Unexpected QA message recipient.');
      const links = String(detail.TextBody ?? '').match(/https:\/\/[^\s<>"']+/g) ?? [];
      const link = links.find(value => value.startsWith(origin + '/api/auth/'));
      if (link) return link;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Production QA authentication email was not delivered.');
}
