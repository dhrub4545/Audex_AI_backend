const mongoose = require('mongoose');
const Audit = require('./models/Audit');

async function run() {
  await mongoose.connect('mongodb+srv://panditdhrub0_db_user:UFrodt4TH58tMiJ7@cluster0.kdzyvft.mongodb.net/?appName=Cluster0');
  console.log('Connected to MongoDB');
  const audit = await Audit.findOne().sort({ createdAt: -1 });
  console.log('Latest Audit:');
  console.log(JSON.stringify(audit, null, 2));
  await mongoose.disconnect();
}

run().catch(console.error);
