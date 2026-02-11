import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { Body, From, MessageSid } = req.body; 

  const session = driver.session();
  try {
    const query = `
      MERGE (l:LEAD { messageId: $msgId })
      ON CREATE SET 
        l.text = $text,
        l.sender = $sender,
        l.status = 'New',
        l.createdAt = datetime()
      RETURN l
    `;

    await session.executeWrite(tx => 
      tx.run(query, { text: Body, sender: From, msgId: MessageSid })
    );

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(`<Response><Message>Lead Recorded!</Message></Response>`);
  } catch (error) {
    console.error(error);
    res.status(500).send('Error');
  } finally {
    await session.close();
  }
}
