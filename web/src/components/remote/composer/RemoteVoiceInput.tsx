import { useVoiceInput } from '../../chatInput/useVoiceInput.js'
import { VoiceButton } from '../../chatInput/VoiceButton.js'

export function RemoteVoiceInput({ onText }: { onText: (text: string) => void }) {
  const voice = useVoiceInput(onText)
  return <VoiceButton status={voice.status} seconds={voice.seconds} disabled={!voice.available}
    onClick={() => void voice.toggle()} />
}
