import anthropicLogo from '../assets/logos/anthropic.svg'
import openaiLogo from '../assets/logos/openai.svg'
import googleLogo from '../assets/logos/google.svg'
import deepseekLogo from '../assets/logos/deepseek.svg'
import moonshotLogo from '../assets/logos/moonshotai.svg'
import zaiLogo from '../assets/logos/zai.svg'
import minimaxLogo from '../assets/logos/minimax.svg'
import tencentLogo from '../assets/logos/tencent.svg'
import qwenLogo from '../assets/logos/qwen.svg'
import nvidiaLogo from '../assets/logos/nvidia.svg'
import xiaomiLogo from '../assets/logos/xiaomi.svg'
import stealthLogo from '../assets/logos/stealth.svg'

/** AI-lab logos keyed by the OpenRouter vendor prefix (the part before the "/" in a model id).
 * Shared by the settings tables and the chat bar. */
export const LAB_LOGOS: Record<string, string> = {
  anthropic: anthropicLogo,
  openai: openaiLogo,
  google: googleLogo,
  deepseek: deepseekLogo,
  moonshotai: moonshotLogo,
  'z-ai': zaiLogo,
  minimax: minimaxLogo,
  tencent: tencentLogo,
  qwen: qwenLogo,
  nvidia: nvidiaLogo,
  xiaomi: xiaomiLogo,
  // OpenRouter's Stealth Program: the provider is deliberately not disclosed, so this is a stand-in
  // rather than a lab mark. No model carries the prefix today — Ox Alpha was retired on 2026-08-26 —
  // and it stays because the next cloaked model will arrive under the same prefix and nothing else
  // in this map would match it.
  stealth: stealthLogo
}

// The rule moved to shared/ when the catalogue began ordering itself by lab: main sorts by it,
// the renderer draws logos by it, and both must mean the same thing. Re-exported here so every
// existing `import { LAB_LOGOS, labKey } from '../lib/labLogos'` keeps working.
export { labKey } from '../../../shared/labKey'
