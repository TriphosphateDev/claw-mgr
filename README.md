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
git clone https://github.com/YOUR_USERNAME/claw-mgr.git
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

## Publish to GitHub

From the `claw-mgr` directory:

```bash
cd claw-mgr
npm install
git init
git add .
git commit -m "Initial commit: Claw Mgr"
```

Create a new repository on GitHub (e.g. `claw-mgr`), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/claw-mgr.git
git branch -M main
git push -u origin main
```

Replace `YOUR_USERNAME` with your GitHub username. Others can then clone and use the repo.

## License

MIT
