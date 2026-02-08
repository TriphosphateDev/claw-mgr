# Claw Mgr

Web UI to control [OpenClaw](https://openclaw.ai) gateway and dashboard. Pick Local (Ollama) or Remote, choose a model, then Start/Stop from the browser.

**Stack:** Express, Vue 2.7, Bootstrap 5. Default port **8011**.

## Features

- **Start / Stop** — Spawns or kills the OpenClaw gateway and dashboard.
- **Model** — Local (Ollama) or Remote; pick an Ollama model before Start. Writes `agents.defaults.model.primary` to `~/.openclaw/openclaw.json`.
- **Heartbeat** — Gateway up/down and last heartbeat time.
- **Activity** — Recent memory log; click a row for details in a modal.
- **Cron jobs** — OpenClaw cron list; click a job for accordion-style schedule/payload.

## Install

```bash
git clone https://github.com/Ascendism/claw-mgr.git
cd claw-mgr
npm install
```

## Run

```bash
npm start
```

Open http://127.0.0.1:8011. Choose Local or Remote and (if Local) an Ollama model, then click **Start** to run the gateway and dashboard. Click **Stop** to stop them.

Set `PORT` to use another port (e.g. `PORT=3000 npm start`).

## Requirements

- Node.js 18+
- [OpenClaw](https://openclaw.ai) installed (`openclaw` on PATH)
- For Local mode: [Ollama](https://ollama.com) running (for model list and inference)

## License

MIT
