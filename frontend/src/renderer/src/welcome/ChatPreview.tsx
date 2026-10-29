/**
 * The chat bar as it looks with the "+" menu open on the skill list — the picture for card 1.
 *
 * A rebuild rather than the real component: CanvasChat needs a model, a project and a live agent,
 * and none of that exists while the tour is up on a fresh install. The shape is what carries the
 * message here — a prompt in plain words, and a menu that shows the assistant is fed with skills
 * rather than left to improvise — so the parts are drawn, but the skill names are the ones the app
 * actually ships (engine/builtin_skills.py).
 *
 * Its own file, like RailPreview: a module that exports both a component and data loses React Fast
 * Refresh, and tourCards.tsx exports TOUR_CARDS.
 */
export default function ChatPreview(): JSX.Element {
  return (
    <div className="wt-chat">
      {/* The "+" menu opens upwards in the real chat bar, so it sits above the field here too. */}
      <div className="wt-chat-menu">
        <div className="wt-chat-menu-h">Skills</div>
        <div className="wt-chat-menu-row on">
          <Check /> LCA model building
        </div>
        <div className="wt-chat-menu-row on">
          <Check /> Bill of materials
        </div>
        <div className="wt-chat-menu-row">
          <span className="wt-chat-box-off" /> Choosing a proxy dataset
        </div>
        <div className="wt-chat-menu-row">
          <span className="wt-chat-box-off" /> Interpreting results
        </div>
        <div className="wt-chat-menu-row">
          <span className="wt-chat-box-off" /> Critical review
        </div>
      </div>

      <div className="wt-chat-field">
        <div className="wt-chat-prompt">
          Build a cradle-to-gate model for a 500 ml glass bottle, filled in Germany.
        </div>
        <div className="wt-chat-bar">
          <span className="wt-chat-btn on" aria-hidden>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
            >
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </span>
          <span className="wt-chat-btn" aria-hidden>
            {/* After Lucide "mic" (ISC, in THIRD-PARTY-NOTICES.md). */}
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </span>
          <span className="wt-chat-model">GPT-6.1 Sol</span>
          <span className="wt-chat-send" aria-hidden>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </span>
        </div>
      </div>
    </div>
  )
}

function Check(): JSX.Element {
  return (
    <span className="wt-chat-check" aria-hidden>
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  )
}
