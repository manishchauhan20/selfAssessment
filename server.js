const { app } = require('./index');
const { connectToDatabase } = require('./config/database');
require('./env');

const PORT = process.env.PORT || 5000;

(async () => {
  await connectToDatabase();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
})();
