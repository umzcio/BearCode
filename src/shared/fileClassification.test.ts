import { describe, expect, it } from 'vitest'
import { defaultsToRenderedPreview, extensionForPath, languageForPath } from './fileClassification'

describe('file classification', () => {
  it.each([
    ['src/app.ts', 'ts', 'typescript'],
    ['src/App.TSX', 'tsx', 'typescript'],
    ['src/app.js', 'js', 'javascript'],
    ['src/view.JSX', 'jsx', 'javascript'],
    ['src/module.mjs', 'mjs', 'javascript'],
    ['src/module.CJS', 'cjs', 'javascript'],
    ['styles/app.css', 'css', 'css'],
    ['styles/app.SCSS', 'scss', 'scss'],
    ['styles/app.less', 'less', 'less'],
    ['scripts/tool.py', 'py', 'python'],
    ['scripts/tool.RB', 'rb', 'ruby'],
    ['cmd/server.go', 'go', 'go'],
    ['crates/lib.rs', 'rs', 'rust'],
    ['src/App.java', 'java', 'java'],
    ['src/App.KT', 'kt', 'kotlin'],
    ['src/main.c', 'c', 'c'],
    ['include/main.H', 'h', 'c'],
    ['src/main.cpp', 'cpp', 'cpp'],
    ['include/main.HPP', 'hpp', 'cpp'],
    ['src/App.cs', 'cs', 'csharp'],
    ['src/app.php', 'php', 'php'],
    ['scripts/tool.sh', 'sh', 'shell'],
    ['scripts/tool.BASH', 'bash', 'shell'],
    ['scripts/tool.zsh', 'zsh', 'shell'],
    ['config/app.yaml', 'yaml', 'yaml'],
    ['config/app.YML', 'yml', 'yaml'],
    ['config/app.toml', 'toml', 'toml'],
    ['config/app.INI', 'ini', 'ini'],
    ['db/query.sql', 'sql', 'sql'],
    ['assets/file.xml', 'xml', 'xml'],
    ['ios/App.swift', 'swift', 'swift'],
    ['pages/index.html', 'html', 'html'],
    ['pages/index.HTM', 'htm', 'html'],
    ['data/package.json', 'json', 'json'],
    ['docs/README.md', 'md', 'markdown']
  ])('normalizes %s as .%s with Monaco language %s', (path, extension, language) => {
    expect(extensionForPath(path)).toBe(extension)
    expect(languageForPath(path)).toBe(language)
  })

  it.each([
    ['README', ''],
    ['.bashrc', ''],
    ['nested/.gitignore', ''],
    ['nested/file.', '']
  ])('falls back for extensionless or dotfile path %s', (path, extension) => {
    expect(extensionForPath(path)).toBe(extension)
    expect(languageForPath(path)).toBe('plaintext')
  })

  it.each([
    ['image.png', true],
    ['image.JPG', true],
    ['image.jpeg', true],
    ['image.gif', true],
    ['image.webp', true],
    ['image.bmp', true],
    ['image.svg', true],
    ['report.pdf', true],
    ['report.docx', true],
    ['sheet.xlsx', true],
    ['page.html', false],
    ['notes.md', false],
    ['data.json', false],
    ['README', false],
    ['.bashrc', false]
  ])('defaults %s to rendered Preview: %s', (path, expected) => {
    expect(defaultsToRenderedPreview(path)).toBe(expected)
  })
})
