VETBEINGS FULL-STACK STORE
1. Install Node.js.
2. Run: npm install
3. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET as SERVER environment variables. Never put the secret in frontend files.
4. Run: npm start
5. Open http://localhost:3000
6. Admin: /admin.html
7. For real payments use an approved Razorpay merchant account, HTTPS, Live Mode keys and configure webhooks before production.
8. This demo stores products/orders in JSON files. For production, replace with a managed database and protect /api/admin routes with authentication.
