import {
  SKIP_MODE_ONE_STEP_NOTE,
  SKIP_MODE_STEP_LABEL,
  SKIP_MODE_STEP_PUSH_NOTE,
  SKIP_MODE_WHOLE_LABEL,
  type SkipMode,
} from '../../lib/checklist-skip.js'

/**
 * Skip a step (featreq-7e1827e0): HOW a skip works on this recipe, shown under
 * "Skipping allowed" only while skipping is allowed. A one-step recipe has nobody
 * after the step, so the choice is shown but disabled and reads as a whole skip.
 */
export function SkipModeChoice({
  name,
  skipMode,
  stageCount,
  onChange,
}: {
  /** The radio group's name; unique per form on the page. */
  name: string
  skipMode: SkipMode | undefined
  stageCount: number
  onChange: (mode: SkipMode) => void
}) {
  const oneStep = stageCount <= 1
  const current: SkipMode = oneStep ? 'whole' : skipMode === 'step' ? 'step' : 'whole'
  return (
    <fieldset className="skip-mode-choice" disabled={oneStep}>
      <legend className="skip-mode-choice-legend">When someone skips</legend>
      <label className="skip-mode-choice-option">
        <input
          type="radio"
          name={name}
          value="whole"
          disabled={oneStep}
          checked={current === 'whole'}
          onChange={() => onChange('whole')}
        />
        <span>{SKIP_MODE_WHOLE_LABEL}</span>
      </label>
      <label className="skip-mode-choice-option">
        <input
          type="radio"
          name={name}
          value="step"
          disabled={oneStep}
          checked={current === 'step'}
          onChange={() => onChange('step')}
        />
        <span>{SKIP_MODE_STEP_LABEL}</span>
      </label>
      {oneStep ? <small className="new-task-hint">{SKIP_MODE_ONE_STEP_NOTE}</small> : null}
      {/* Push a step (featreq-78f09571): the same choice decides what a push does. */}
      {!oneStep && current === 'step' ? (
        <small className="new-task-hint">{SKIP_MODE_STEP_PUSH_NOTE}</small>
      ) : null}
    </fieldset>
  )
}
