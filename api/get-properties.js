import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

export default async function handler(req, res) {
  // Essential CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = driver.session();
  try {
    const result = await session.run(
      'MATCH (p:Property) RETURN p {.*} AS property'
    );
    const properties = result.records.map(record => record.get('property'));
    return res.status(200).json(properties);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
}
