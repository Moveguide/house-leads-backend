import neo4j from 'neo4j-driver';

const driver = neo4j.driver(
  process.env.NEO4J_URI,
  neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASSWORD)
);

export default async function handler(req, res) {
  // CORS so your Agent App can talk to it
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address, roleConfirmed, accountName, accountNumber } = req.body;
  const session = driver.session();

  try {
    await session.executeWrite(tx =>
      tx.run(
        `MATCH (p:Property {address: $address})
         SET p.status = 'Verified', 
             p.verifiedAt = datetime(),
             p.confirmedRole = $roleConfirmed,
             p.payoutAccountName = $accountName,
             p.payoutAccountNumber = $accountNumber
         RETURN p`,
        { address, roleConfirmed, accountName, accountNumber }
      )
    );
    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  } finally {
    await session.close();
  }
}
