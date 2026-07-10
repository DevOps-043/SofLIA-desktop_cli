# SofLIA - Engine Render Worker

Local Remotion render worker for SofLIA - Engine.

## MVP commands

```bash
npm install
npm run build
soflia-engine-worker configure --api-url http://localhost:4000 --token swk_xxx
soflia-engine-worker doctor
soflia-engine-worker render --job-id <production_job_id>
```

The CLI never uses `SUPABASE_SERVICE_ROLE_KEY` and never talks to Supabase directly. It only calls the SofLIA - Engine worker HTTP API with a limited worker token.
