# Green Meadows Society Manager

A residential society management app: flats and owners, maintenance staff, service requests, monthly maintenance bills (with late fees for unpaid months) and a security-gate visitor log.

**Stack:** Node.js + Express (backend API), PostgreSQL (database), plain HTML/CSS/JavaScript (frontend, served by Express).

## Roles and demo PINs

| Role | PIN | Can do |
|---|---|---|
| Secretary | 1111 | Everything: flats, staff, service requests; view bills and gate log |
| Treasurer | 2222 | Dashboard, flats list, generate bills, record payments |
| Security | 3333 | Record visitors in and out; flats directory (no dues shown) |
| Resident | 4444 | Own flat only: raise requests, pay bills, see visitors |

Change the PINs in production by setting the environment variables `SECRETARY_PIN`, `TREASURER_PIN`, `SECURITY_PIN`, `RESIDENT_PIN`.

## Project structure

```
server.js              backend: REST API, role checks, database setup
public/index.html      frontend: single-page app
society_dataset.sql    schema + sample data (120 flats, 3 buildings), loaded on first start
package.json           dependencies and start script
render.yaml            Render Blueprint (web service + PostgreSQL)
```

## Deploy on Render (GitHub + Render)

1. Create a new GitHub repository and upload all files above, keeping the `public` folder.
2. In Render, choose **New > Blueprint**, connect the GitHub repo and apply. Render reads `render.yaml` and creates the web service and the PostgreSQL database, and sets `DATABASE_URL` and `JWT_SECRET` for you.
3. Wait for the deploy to finish, then open the service URL. On first start the app creates the tables and loads the sample data automatically.

Manual alternative: create a PostgreSQL database in Render, then a Web Service from the repo with build command `npm install`, start command `npm start`, and environment variables `DATABASE_URL` (the database's Internal Database URL) and `JWT_SECRET` (any long random text).

Free-plan notes: free web services sleep after inactivity (first load can take about a minute), and free PostgreSQL databases have limits and expiry. Check Render's current pricing page.

## Run locally

```
npm install
createdb society
DATABASE_URL=postgres://localhost:5432/society npm start
```
Open http://localhost:3000

## API summary

`POST /api/login` then send `Authorization: Bearer <token>`.

| Endpoint | Roles |
|---|---|
| GET /api/dashboard | Secretary, Treasurer |
| GET, POST /api/apartments; DELETE /api/apartments/:id | read: Secretary, Treasurer, Security; write: Secretary |
| GET, POST /api/staff; DELETE /api/staff/:id | read: Secretary, Treasurer, Security; write: Secretary |
| GET, POST /api/requests; PATCH /api/requests/:id | Secretary (all), Resident (own flat) |
| GET /api/bills; POST /api/bills/generate | read: Secretary, Treasurer, Resident; generate: Treasurer |
| POST /api/bills/:id/pay, POST /api/apartments/:id/pay-all | Treasurer, Resident (own) |
| GET, POST /api/visits; PATCH /api/visits/:id/checkout | read: Secretary, Security, Resident; write: Security |
