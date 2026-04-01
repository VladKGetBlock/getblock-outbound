# GetBlock.io — Outbound Intelligence Platform

Web3 sales automation app. Stores companies from Clay, tracks contacts, manages outreach pipeline.

## Local development

```bash
npm install
npm start
# Open http://localhost:3000
```

## Deploy to Railway

1. Push to GitHub
2. railway.app → New Project → Deploy from GitHub repo
3. Select this repo → Deploy
4. Settings → Domains → Generate Domain
5. Update webhook URLs in Clay and Instantly with your Railway URL

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/companies | List all companies |
| GET | /api/stats | Dashboard stats |
| POST | /api/companies/upload | Upload Clay CSV |
| POST | /api/webhook/inbound | Clay pushes enriched leads |
| POST | /api/webhook/reply | Reply notifications |
| GET | /api/responses | List replies |
| PATCH | /api/companies/:id | Update company |
| DELETE | /api/companies/:id | Remove company |

## Data persistence on Railway

Add a Railway Volume in the Storage tab, mounted at `/app/data`.
This keeps your database across deploys.

## Clay webhook body format

```json
{
  "company": "Company Name",
  "website": "website.com",
  "vertical": "DeFi Protocol",
  "chain": "Ethereum",
  "signal": "Recent trigger event",
  "name": "First Last",
  "role": "CTO",
  "email": "email@company.com",
  "linkedin": "linkedin.com/in/...",
  "score": "15",
  "message": "Personalized outreach message"
}
```
