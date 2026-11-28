# Chat

The assistant's chat dock in the lower right of the Model page. Collapsed it is a single input bar; it
opens into a panel with the conversation, the run's status, plans, question cards and tool traces.

## Sub-features

- Compose and send; while a run works, Enter queues the next message ("Send after the current step")
  and Stop ends the run.
- The run's status bar (what it is doing, timers, call count), tool traces that fold into one summary
  button ("N tool calls · …") once the turn is stored.
- Question cards (`ask_user`) and confirmation cards for steps that cannot be undone; a banner on other
  pages ("… has a question for you", "Go to chat") when a card waits off screen.
- A plan card with steps, and "Continue" after a run stopped (cost limit, round limit, stopped by you,
  app closed).
- The chat model picker with reasoning effort; the "+" menu with attachments, web search, databases to
  search, comparison models and skills; voice input.
- Several chats per model: switch, new, delete; "N other runs" when the assistant works elsewhere.
- Charts in an answer: an `echarts` block the assistant writes (bar or pie) is drawn as a chart with a
  "Save chart as PNG" button; a block it cannot draw stays as code under "Not drawn as a chart: …".

## How to get there

Open a model (see model.md): the dock sits at the bottom right of the canvas. Clicking into the field
opens the panel; "Collapse" (✕) in its header folds it again. There is no chat on the other pages.

A provider key is entered under Settings (`"title=Settings"`) → AI → Provider; without one the field is
disabled and says so.

## Driving it with control-prism

What a fresh instance offers — the dock without a key — and the model picker, which needs none:

```sh
node scripts/control-prism.mjs click "role=navigation:Pages >> role=button:Model"
node scripts/control-prism.mjs wait disabled "Message to the assistant"
node scripts/control-prism.mjs wait attr "Message to the assistant" placeholder "/No OpenRouter API key/"
node scripts/control-prism.mjs wait disabled "Send"
node scripts/control-prism.mjs click "role=button:/^Chat model:/"
node scripts/control-prism.mjs snapshot --target "role=menu:Chat model"
node scripts/control-prism.mjs press Escape
```

- The field is `"Message to the assistant"`; `"Send"`, `"Stop"` and `"Send after the current step"` are
  the buttons beside it; `"Attachments and chat options"` opens the "+" menu, `"Record a voice message"`
  the microphone.
- The picker is the button whose name starts with "Chat model:"; its menu `"role=menu:Chat model"` lists
  the models as `menuitemradio` entries.
- With a run going: `wait chat-running` holds while the Stop button is there, `wait chat-idle` returns
  once the run ended. A stored turn's traces fold into `"role=button:/tool calls/"`.
- Question cards: `"css=.chat-ask"` with option buttons and `"role=button:Answer"`; a confirmation card is
  `"role=group:Confirmation request"` with "Allow" and "Decline".
- A chart in an answer is an image named after its title — `"role=img:Footprint"` in the recipe below,
  "Bar chart" or "Pie chart" for a chart without one —, its button
  `"role=button:Save chart as PNG"`, which delivers `prism-chart-<title>.png`; a block that was not drawn
  leaves `"css=.chat-chart-note"` beside its code. While an answer streams, an unfinished chart block
  shows "Drawing a chart…".

A chart without paying for a run: store an answer in a chat of the open model through the chat API, then
restart and open the chat as a person does. The store is preparation, not the proof:

```sh
node scripts/control-prism.mjs read "window.prism.api('POST', '/api/v1/ai/chats/bottle', {title: 'Charts'}).then(r => r.body.id)"
node scripts/control-prism.mjs read "window.prism.api('POST', '/api/v1/ai/chats/bottle/<id>/messages', {messages: [{role: 'user', content: 'Chart?'}, {role: 'assistant', content: 'Here:\n\n\`\`\`echarts\n{\"title\": {\"text\": \"Footprint\"}, \"xAxis\": {\"data\": [\"A\", \"B\"]}, \"series\": [{\"type\": \"bar\", \"data\": [2, -1]}]}\n\`\`\`'}]}).then(r => r.status)"
node scripts/control-prism.mjs restart
node scripts/control-prism.mjs wait app-ready
node scripts/control-prism.mjs click "role=navigation:Pages >> role=button:Model"
node scripts/control-prism.mjs select "Active model" bottle
node scripts/control-prism.mjs click "Message to the assistant"
node scripts/control-prism.mjs wait visible "role=img:Footprint"
```

The panel opens only with a key (`launch --keys`); nothing here sends a message.

## Gotchas

- **A fresh instance cannot chat.** It starts without a provider key, its separate profile has no
  credential store to keep one in, and the launch passes no key on — neither from the environment nor
  from the checkout's own key files (`.secrets/`). The field, "+" and the microphone stay disabled, and
  the panel does not open. The model picker and the Settings pages work.
- **A message costs money** once there is a key: never send one in a check unless the person running it
  asked for it.
- The panel exists only while open: collapsed, there is no header, transcript or status bar to find.
  Only focusing the field opens it (and only with a key); clicking the model picker or "+" does not.
- The placeholder changes with the state (no key, a run going, a question waiting): wait on it as a
  state, but name the field by its label.
- A run is going exactly while the Stop button is there. Trace rows fold into one summary button when
  the turn is stored, so counting trace rows after the end finds none.
- "New chat" stores an empty chat at once; "Delete chat" asks for no confirmation.
- Attaching files opens a native file dialog, and dropping files onto the chat needs a drag in from
  another program: both manual.
- A chart is drawn only while its box is in or near the transcript's view; far off it is an empty box of
  the chart's height, with no `role=img`. Scroll it into view before waiting on it. An answer draws at
  most four charts; further blocks stay code.
