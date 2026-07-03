// Phase 1 static data. The model registry, sidebar contents, scripted agent
// run, and staged diff all mirror design/bearcode-prototype.html. Real data
// replaces this from Phase 2 onward.

export interface ProviderGroup {
  id: string
  name: string
  color: string
  local?: boolean
  models: string[]
}

export const PROVIDERS: ProviderGroup[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    color: '#d97757',
    models: ['Claude Opus 4.8', 'Claude Sonnet 4.6', 'Claude Haiku 4.5']
  },
  { id: 'openai', name: 'OpenAI', color: '#9ad0b7', models: ['GPT-5.2', 'GPT-5.2 mini', 'o4'] },
  {
    id: 'google',
    name: 'Google',
    color: '#4c8dff',
    models: ['Gemini 3.1 Pro (High)', 'Gemini 3.1 Pro (Low)', 'Gemini 3 Flash']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    color: '#b58cff',
    models: ['DeepSeek V4', 'Kimi K2.5', 'GLM-5']
  },
  {
    id: 'ollama',
    name: 'Ollama',
    color: '#3ecf8e',
    local: true,
    models: ['llama3.3:70b', 'qwen3-coder:32b', 'gemma3:27b']
  }
]

export const DEFAULT_MODEL = { name: 'Gemini 3.1 Pro (High)', color: '#4c8dff' }

export const HOME_WORKSPACE = {
  path: '/Users/zach/Downloads/EducationalResearch',
  shortLabel: '/Users/zach/Downloads/Education…',
  projectLabel: 'Downloads'
}

export interface MockConvoSeed {
  id: string
  name: string
  age?: string
  activeRun?: boolean
}

export interface MockProjectGroup {
  label: string
  convos: MockConvoSeed[]
  emptyNote?: string
}

export const MOCK_GROUPS: MockProjectGroup[] = [
  {
    label: 'Downloads',
    convos: [
      { id: 'gasb', name: 'Downloading GASB Activity Reports', age: '14d' },
      { id: 'acsm', name: 'Converting ACSM File Contents', activeRun: true }
    ]
  },
  {
    label: '/Users/zach/Downloads/Educ…',
    convos: [{ id: 'textbook', name: 'Digitizing Textbook Content', age: '25d' }]
  },
  { label: '/', convos: [], emptyNote: 'No conversations yet' }
]

// ---- Scripted agent run content (from the prototype simulation) ----

export const DEMO_THINKING = `### Scoping the request
The user wants the screenshots in this folder transcribed into a clean Markdown appendix. I should scan the workspace first rather than assume filenames, and I'm making sure I *never* use \`cat\` for file creation, I'll write files through the proper tool so edits show up as reviewable diffs.

### Choosing an approach
Plan: enumerate the folder, OCR-check whether text extraction is viable with \`pypdf\`, then compose \`AppendixD.md\` preserving the question lists and section structure.`

export const DEMO_EXPLORED_OUTPUT = `EducationalResearch/
EducationalResearch/Chapter001/   ·   14 files, 6 screenshots`

export const DEMO_COMMAND_LABEL = `python3 -c ' import sys import subprocess try: import pypdf except ImportError: subpr…`

export const DEMO_COMMAND_OUTPUT = `$ python3 -c 'import sys, subprocess; ...'
pypdf 5.1.0 available
6 image files detected · text layer: none · OCR path selected`

export const DEMO_ASSISTANT_TEXT = `I have transcribed all the provided screenshots and created \`AppendixD.md\` for "Strategies for Defending a Research Proposal." The question lists and sections have all been formatted with proper Markdown headings.

Let me know if there's anything else you'd like to work on, or if we have another appendix or chapter to tackle next.`

// ---- Staged diff shown in the review modal ----

export const APPENDIX_MD = `# Appendix D — Strategies for Defending a Research Proposal

## D.1 Anticipating Committee Questions

Preparing for a proposal defense begins with anticipating the
categories of questions committees most frequently raise.

### Methodological questions

1. Why is this design appropriate for the research questions?
2. How were the participants or data sources selected?
3. What are the limitations of the chosen instruments?
4. How will validity and reliability be addressed?

### Theoretical framing

1. Which framework anchors the study, and why this one?
2. How does the framework shape the analysis plan?
3. What competing frameworks were considered and rejected?

### Significance and contribution

1. Who benefits from this study, and how?
2. What does this add beyond the existing literature?
3. How might the findings generalize or transfer?

## D.2 Structuring the Defense Presentation

A defense presentation should move from problem to plan in under
twenty minutes, reserving the majority of the session for dialogue.

1. Open with the problem statement and why it matters now.
2. Situate the study in the literature with two or three anchors.
3. State the research questions verbatim from the proposal.
4. Walk the design end to end: sampling, instruments, procedure.
5. Preview the analysis plan and the criteria for quality.
6. Close with limitations, timeline, and expected contribution.

## D.3 Handling Difficult Moments

### When you do not know the answer

Acknowledge the gap directly, connect it to what you do know, and
offer to follow up in writing. Committees respect candor over bluff.

### When committee members disagree with each other

Do not referee. Restate both positions accurately, identify what
your study can and cannot resolve, and defer procedural rulings to
the chair.

### When asked to expand the scope

Thank the questioner, then return to the boundaries set by the
research questions. Note the suggestion as future work in the
revision memo.

## D.4 The Revision Memo

After the defense, produce a one-page memo listing each committee
request, the change made in response, and the page number where the
change appears. Circulate it with the revised proposal within two
weeks.`

export interface StagedFile {
  name: string
  path: string
  status: 'created' | 'modified' | 'deleted'
  before: string
  after: string
  additions: number
  deletions: number
}

export const DEMO_DIFF: Record<string, StagedFile[]> = {
  'demo-diff': [
    {
      name: 'AppendixD.md',
      path: '/Users/zach/Downloads/EducationalResearch/Chapter001',
      status: 'created',
      before: '',
      after: APPENDIX_MD,
      additions: 64,
      deletions: 0
    }
  ]
}
