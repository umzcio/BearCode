import { describe, it, expect } from 'vitest'
import { HumanMessage } from '@langchain/core/messages'
// Deliberately reaches into @langchain/openai's dist internals (the converter
// is not on the package's public export map): this test pins the local
// patch-package fix in patches/@langchain+openai+1.5.5.patch. If node_modules
// is ever reinstalled without `patch-package` running (postinstall), this
// fails loudly instead of image attachments 400ing at OpenAI's Responses API.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- internal dist path, no type declarations exported for it
import { convertMessagesToResponsesInput } from '../../../node_modules/@langchain/openai/dist/converters/responses.cjs'

describe('@langchain/openai Responses converter (patched)', () => {
  it('converts a base64 image data block to input_image, never image_url', () => {
    const msg = new HumanMessage({
      content: [
        { type: 'text', text: 'Incorporate this as the mascot.' },
        { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'AAAA' }
      ]
    })
    const input = convertMessagesToResponsesInput({
      messages: [msg],
      zdrEnabled: false,
      model: 'gpt-5.6-sol'
    }) as Array<{ type: string; content: Array<{ type: string; image_url?: string }> }>

    const parts = input[0].content
    expect(parts.map((p) => p.type)).toEqual(['input_text', 'input_image'])
    expect(parts[1].image_url).toBe('data:image/png;base64,AAAA')
    // The unpatched converter emitted a Chat-Completions-style image_url part,
    // which OpenAI's Responses endpoint rejects with
    // "400 Invalid value: 'image_url'".
    expect(JSON.stringify(input)).not.toContain('"type":"image_url"')
  })

  it('converts a url image data block to input_image', () => {
    const msg = new HumanMessage({
      content: [{ type: 'image', source_type: 'url', url: 'https://example.com/bear.png' }]
    })
    const input = convertMessagesToResponsesInput({
      messages: [msg],
      zdrEnabled: false,
      model: 'gpt-5.6-sol'
    }) as Array<{ content: Array<{ type: string; image_url?: string }> }>
    expect(input[0].content[0]).toEqual({
      type: 'input_image',
      detail: 'auto',
      image_url: 'https://example.com/bear.png'
    })
  })
})
