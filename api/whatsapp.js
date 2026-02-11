    // Inside your try block, after the AI extraction:
    const query = `
      // 1. Find or create the Person
      MERGE (p:Person { whatsapp: $sender })
      
      // 2. Find or create the Property
      MERGE (prop:Property { address: $address })
      ON CREATE SET prop.extractedPhone = $phone
      
      // 3. Link them together
      MERGE (p)-[r:LISTED]->(prop)
      ON CREATE SET 
        r.createdAt = datetime(),
        r.status = 'Pending_NIN',
        r.originalText = $text
        
      RETURN p, prop
    `;

    await session.executeWrite(tx => 
      tx.run(query, { 
        sender: From, 
        address: extracted.address || "Unknown Address", 
        phone: extracted.phone,
        text: Body 
      })
    );

    // 4. Smart Reply
    const reply = extracted.address 
      ? `Got it! To list "${extracted.address}", please reply with a photo of your NIN or Utility Bill for verification.`
      : `Thanks for reaching out! Could you please provide the full address of the property?`;

    res.status(200).send(`<Response><Message>${reply}</Message></Response>`);
