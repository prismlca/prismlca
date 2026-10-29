# PrismLCA privacy notice

*Version of 16 October 2026. This notice ships with the app and describes the build it comes with. The website www.prismlca.com has its own notice.*

## Who is responsible

Jonas Harth, contact@prismlca.com. PrismLCA is a private open-source project; there is no company behind it and no data protection officer, because the law requires none for it.

## The short version

PrismLCA runs on your computer. There is no account, no cloud, no telemetry, no crash reporting, no analytics and no licence server. Your models, databases, results, reports and chats are files on your machine. The online features below send the parts they name directly to the service you use; the developer of PrismLCA receives none of it.

Nothing leaves your computer unless you switch a feature on, enter an API key, or click a button that says it will contact a server. Every such feature is listed below with what it sends and to whom. Without a key and without a click, PrismLCA makes no request at all.

## Connections you can switch on

### Update check

*Trigger:* the button **Check for updates** under Settings → About. PrismLCA never checks on its own.
*Sent to:* GitHub, Inc. (a Microsoft company, USA), which hosts PrismLCA's releases. GitHub takes part in the EU–US Data Privacy Framework; how long GitHub keeps request logs is described in [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).
*Data:* your IP address and the PrismLCA version you run. No device or installation identifier.
*Legal basis:* Art. 6(1)(b) and (f) GDPR — you ask for the check; the download starts only after you confirm it.

### News on the start page

*Trigger:* the button **Load news from prismlca.com** on the start page, or the switch *Load news at every start* under Settings → General, which is off until you turn it on.
*Sent to:* prismlca.com, hosted by Hetzner Online GmbH (Germany) on servers in Helsinki, Finland, and delivered through Cloudflare, Inc. (USA; Data Privacy Framework participant).
*Data:* your IP address and the time of the request. Server logs are kept for no longer than seven days.
*Legal basis:* Art. 6(1)(a) GDPR — your consent, given by the click or the switch, withdrawn by turning the switch off.

### Search model download

*Trigger:* the dialog on first start. PrismLCA searches databases with a language model that runs locally; it is not part of the installer, so the first start asks whether to download it (about 2.3 GB). Without it PrismLCA does not run; the dialog offers to quit instead.
*Sent to:* Hugging Face, Inc. (USA), huggingface.co.
*Data:* your IP address and the download library's user agent, which names the versions of that library, of Python and of PyTorch. The library's usage telemetry and its automatic weight conversion, which would otherwise contact the site again, are switched off. Nothing about you or your workspaces. The download happens once; afterwards the model is loaded from your disk only.
*Who processes it:* the request goes from your computer straight to Hugging Face, which handles it as the operator of its site under its own [privacy policy](https://huggingface.co/privacy); the developer of PrismLCA receives nothing. We point PrismLCA at that download because the search then works offline: only an IP address and a library version leave your computer, once, for a model that keeps every later search local.

### AI assistant, report writer and import matching

*Trigger:* an API key you enter under Settings → AI → Provider, and then every message you send, every chapter you let the assistant write, every import you let it match.
*Sent to:* the provider you chose — OpenRouter, Inc. (USA) or OpenAI (USA). Your key means your contract: the provider processes what PrismLCA sends under its own terms and privacy policy ([OpenRouter](https://openrouter.ai/privacy), [OpenAI](https://openai.com/policies/privacy-policy)). PrismLCA has no server in between and never sees your key or your conversations.
*Data:* your message, the conversation so far, the parts of your model and results the assistant is working on, the results of the tools it calls (which can include names and values from your background databases), attachments you add, and the skills and report text involved. Web search — in the chat when it is on, and when a report's Introduction or Interpretation is written while its "Search the literature" box is ticked (as it is unless you untick it) — runs on the provider's side; PrismLCA does not choose or know the search engine behind it. A PDF attached for a model that cannot read PDFs itself is converted to text by OpenRouter's parser, which runs at Cloudflare, Inc.
*What PrismLCA does on your behalf:* it asks OpenRouter for providers that do not collect data (`data_collection: deny`) and for endpoints that retain nothing (`zdr`). Anthropic, OpenAI and Google models are exempt from the second request by default, because some of them have no such endpoint; they then run under the vendor's own retention terms. That includes the default chat model on OpenRouter, OpenAI's GPT-6.1 Sol, and every Gemini model: Google serves them only from its own endpoints (Vertex AI and Google AI Studio), which keep prompts for a limited time to detect abuse. Settings → AI → Limits lets you make any of the three vendors strict. With OpenAI as your provider, PrismLCA sends requests without server-side storage (`store: false`). These are requests to the provider, not guarantees from PrismLCA.
*Who is responsible:* the developer of PrismLCA receives neither your prompts, nor your files, nor your key; your provider's terms govern what it does with them. If you send personal data about other people, you are responsible for having a legal basis for it and for any contract or transfer safeguards it needs.

### Voice input

*Trigger:* the microphone button in the chat, while a provider key is present. Recording starts on click and stops on click.
*Sent to:* the same provider as the assistant (OpenRouter's Whisper endpoint, or OpenAI's transcription model), under your contract with it.
*Data:* the audio you recorded and the language you picked. The transcript is then sent as your chat message.

### Transport distances

*Trigger:* a key or token you enter under Settings → Transport distances, then the Distances panel, its address suggestions while you type, and the assistant's distances tool.
*Sent to:* HeiGIT gGmbH (Heidelberg, Germany) for openrouteservice, or Mapbox, Inc. (USA) if you choose it as geocoder, under your account with them.
*Data:* the place names and addresses you type, a country code if you set one, and coordinates for routing. An address can be personal data — a supplier's site, someone's home — so type only what you need.

### Waste statistics (Eurostat)

*Trigger:* the assistant's Eurostat tool, on while a provider key is present and until you switch it off under Settings → AI → Chat or in the chat's "+" menu.
*Sent to:* the European Commission's Eurostat API (EU).
*Data:* the dataset code and the filters — country, waste and material codes, years. Nothing from your workspace.

### External agents (MCP)

*Trigger:* the switch **Let external agents drive PrismLCA (MCP server)** under Settings → AI → MCP, off until you turn it on. While it is on, an AI client on this computer that you connected yourself — Claude Code, Codex, Claude Desktop — can read and change your models through the same tools as the assistant. Every change is logged under the client's name and can be undone; before an operation that cannot be undone, the client has to ask you in PrismLCA.
*Sent to:* nowhere by PrismLCA. The client runs on your computer and reaches PrismLCA over a local connection (127.0.0.1) that never leaves it. What the client does with the answers — typically, send them to its own AI provider — is governed by that client and by your contract with its provider, not by PrismLCA.
*Data:* whatever the client asks for: model contents, search results from the background databases, calculation results, study metadata.
*Legal basis:* Art. 6(1)(b) GDPR — you switch the connection on; the client's provider is your own contract with them.

### Links

Links in PrismLCA open in your browser. From there on, the page you opened applies its own rules.

## What stays on this computer

PrismLCA keeps, in your user folder and inside each workspace: your settings, your API keys (encrypted with the operating system's key store where one exists), the models and databases you imported, the search index, the complete transcripts of your chats with the assistant including what its tools returned, copies of the files you attached, the assistant's research and review notes, your reports, and an audit log of changes. Deleting a workspace removes its files; deleting the PrismLCA user folder removes the rest. PrismLCA uploads none of it on its own; only the online features above send the parts they name, and only when you use them.

## What we never do

We do not sell, share or rent personal data. We do not profile anyone and make no automated decisions about anyone. We do not collect usage data. Apart from the one-time download of the search model, which PrismLCA needs to run, no feature above is required: leaving it off only means that feature is unavailable.

## Your rights

Where PrismLCA's developer processes your data — the update check via GitHub and the news feed, both of which see an IP address — you have the rights of access, rectification, erasure, restriction of processing and data portability (Art. 15–20 GDPR), and the **right to object** to processing based on legitimate interests (Art. 21 GDPR). Consent you gave can be withdrawn at any time with effect for the future, by turning the feature off. You can lodge a complaint with a supervisory authority; the one responsible for PrismLCA's developer is the Landesbeauftragte für den Datenschutz und die Informationsfreiheit Baden-Württemberg, Germany (www.baden-wuerttemberg.datenschutz.de).

Write to contact@prismlca.com. We keep no records about app users beyond the server logs named above; if we cannot find data relating to you in them, we will tell you, and you can give us details that help us find it.

## Users outside the EU

The same rules apply to everyone, wherever you are. PrismLCA sells or shares no personal information in the sense of the California Consumer Privacy Act or any similar law, and collects none it could sell.

## Changes

A changed notice carries a new date at the top and appears in the app's What's-new list. The copy in the app is the one that applies to that version.
