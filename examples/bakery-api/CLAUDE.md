# Bakery API: rules for Claude

## Database
- Use Prisma for all database queries. Never write raw SQL.
- For reports, use raw SQL because it is faster.

## Code style
- Write good code.
- Be careful with errors.
- Put tests next to the file: orders.service.js -> orders.service.test.js
- Use the logger from src/common/logger.js, never console.log

## API
- Follow the API pattern in docs/api-guide.md
- Run `npm run test:e2e` before finishing.

## Testing
- Put tests next to the file: orders.service.js -> orders.service.test.js
