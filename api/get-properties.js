import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', process.env.NEO4J_PASSWORD)
);

export default async function handler(req, res) {
  // CORS Headers so Lovable can read this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = driver.session();
  try {
    // This query pulls the properties you saved via WhatsApp
    const result = await session.run(
      `MATCH (p:Property) 
       RETURN p {.*, status: p.status} AS property 
       ORDER BY p.address ASC`
    );
    
    const properties = result.records.map(record => record.get('property'));
    return res.status(200).json(properties);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
}
