/**
 * StepFun 适配器（www.stepfun.com）
 *
 * 站点特征：
 * - 聊天路由为 /chats/new 与 /chats/{id}
 * - 输入框使用原生 textarea
 * - 消息列表中的每条消息根节点带有 data-id，用户/助手通过 justify-end / justify-start 区分
 */
import { SITE_IDS } from "~constants"
import { htmlToMarkdown } from "~utils/exporter"

import {
  SiteAdapter,
  type ConversationInfo,
  type ConversationObserverConfig,
  type ExportConfig,
  type OutlineItem,
} from "./base"

const HOSTNAMES = new Set(["www.stepfun.com", "stepfun.com"])
const CHAT_PATH_PATTERN = /^\/chats\/([^/?#]+)(?:\/|$)/i
const NEW_CHAT_PATH = "/chats/new"

const TEXTAREA_SELECTORS = [
  "#contentContainer textarea:not([disabled])",
  "textarea:not([disabled])",
]

const SIDEBAR_LINK_SELECTOR = 'a[href^="/chats/"]:not([href="/chats/new"])'

const TURN_SELECTOR = "div[data-id]"
const USER_TURN_SELECTOR = `${TURN_SELECTOR}.justify-end`
const ASSISTANT_TURN_SELECTOR = `${TURN_SELECTOR}.justify-start`

const USER_BUBBLE_SELECTOR = `${USER_TURN_SELECTOR} [class*="claw-bubble"]`
const ASSISTANT_BUBBLE_SELECTOR = `${ASSISTANT_TURN_SELECTOR} [class*="claw-bubble"]`
const ASSISTANT_MARKDOWN_SELECTOR = [
  `${ASSISTANT_TURN_SELECTOR} [class*="claw-markdown-content"]`,
  `${ASSISTANT_TURN_SELECTOR} [class*="thought-card-markdown"]`,
].join(", ")
const ASSISTANT_EXPORT_SELECTOR = [
  ASSISTANT_BUBBLE_SELECTOR,
  `${ASSISTANT_TURN_SELECTOR} [class*="thought-card"]`,
  `${ASSISTANT_TURN_SELECTOR} [class*="tool-card"]`,
].join(", ")

const RESPONSE_CONTAINER_SELECTOR = "#contentContainer"
const GENERATING_SELECTOR = [
  `${ASSISTANT_TURN_SELECTOR} .h-7.flex.items-center`,
  `${ASSISTANT_TURN_SELECTOR} [class*="tool-card-running"]`,
  `${ASSISTANT_TURN_SELECTOR} [class*="thought-card-running"]`,
].join(", ")

const MAX_OUTLINE_TEXT_LENGTH = 80

export class StepFunAdapter extends SiteAdapter {
  match(): boolean {
    return HOSTNAMES.has(window.location.hostname)
  }

  getSiteId(): string {
    return SITE_IDS.STEPFUN
  }

  getName(): string {
    return "StepFun"
  }

  getThemeColors(): { primary: string; secondary: string } {
    return { primary: "#c88a2b", secondary: "#9f6b1f" }
  }

  getTextareaSelectors(): string[] {
    return [...TEXTAREA_SELECTORS]
  }

  isValidTextarea(element: HTMLElement): boolean {
    if (!super.isValidTextarea(element)) return false
    if (!(element instanceof HTMLTextAreaElement)) return false
    if (element.closest('[role="dialog"]')) return false

    const rect = element.getBoundingClientRect()
    return rect.width > 180 && rect.height > 24
  }

  insertPrompt(content: string): boolean {
    const editor = this.getTextareaElement() as HTMLTextAreaElement | null
    if (!editor || !editor.isConnected) return false

    editor.focus()

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    if (setter) {
      setter.call(editor, content)
    } else {
      editor.value = content
    }

    editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: content }))
    editor.dispatchEvent(new Event("change", { bubbles: true }))
    editor.setSelectionRange(content.length, content.length)
    return true
  }

  clearTextarea(): void {
    const editor = this.getTextareaElement() as HTMLTextAreaElement | null
    if (!editor || !editor.isConnected) return

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
    if (setter) {
      setter.call(editor, "")
    } else {
      editor.value = ""
    }

    editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: "" }))
    editor.dispatchEvent(new Event("change", { bubbles: true }))
    editor.setSelectionRange(0, 0)
  }

  getSessionId(): string {
    const match = window.location.pathname.match(CHAT_PATH_PATTERN)
    const sessionId = match?.[1]?.trim() || ""
    return sessionId === "new" ? "" : sessionId
  }

  isNewConversation(): boolean {
    const path = window.location.pathname.replace(/\/+$/, "") || "/"
    return path === "/" || path === NEW_CHAT_PATH
  }

  getNewTabUrl(): string {
    return "https://www.stepfun.com/chats/new"
  }

  getSessionName(): string | null {
    const title = document.title.trim()
    if (!title) return null

    const cleaned = title
      .replace(/\s*[|｜-]\s*阶跃AI$/i, "")
      .replace(/\s*[|｜-]\s*StepFun$/i, "")
      .trim()

    if (!cleaned || /^(阶跃AI|StepFun)$/i.test(cleaned)) {
      return null
    }

    return cleaned
  }

  getConversationTitle(): string | null {
    return this.getSessionName()
  }

  getResponseContainerSelector(): string {
    return RESPONSE_CONTAINER_SELECTOR
  }

  getChatContentSelectors(): string[] {
    return [USER_TURN_SELECTOR, ASSISTANT_TURN_SELECTOR]
  }

  getUserQuerySelector(): string | null {
    return USER_TURN_SELECTOR
  }

  extractUserQueryText(element: Element): string {
    const bubble = this.findUserBubble(element)
    if (!bubble) return ""

    return this.extractTextWithLineBreaks(bubble).trim()
  }

  extractUserQueryMarkdown(element: Element): string {
    const bubble = this.findUserBubble(element)
    if (!bubble) return ""

    return htmlToMarkdown(bubble).trim() || this.extractUserQueryText(element)
  }

  getExportConfig(): ExportConfig {
    return {
      userQuerySelector: USER_BUBBLE_SELECTOR,
      assistantResponseSelector: ASSISTANT_EXPORT_SELECTOR,
      turnSelector: TURN_SELECTOR,
      useShadowDOM: false,
    }
  }

  getConversationList(): ConversationInfo[] {
    const links = Array.from(
      document.querySelectorAll(SIDEBAR_LINK_SELECTOR),
    ) as HTMLAnchorElement[]
    if (links.length === 0) return []

    const deduped = new Map<string, ConversationInfo>()
    links.forEach((link) => {
      const info = this.extractConversationInfo(link)
      if (info && !deduped.has(info.id)) {
        deduped.set(info.id, info)
      }
    })

    return Array.from(deduped.values())
  }

  getConversationObserverConfig(): ConversationObserverConfig | null {
    return {
      selector: SIDEBAR_LINK_SELECTOR,
      shadow: false,
      extractInfo: (el) =>
        el instanceof HTMLAnchorElement ? this.extractConversationInfo(el) : null,
      getTitleElement: (el) => this.findConversationTitleElement(el as HTMLElement) || el,
    }
  }

  getSidebarScrollContainer(): Element | null {
    const firstLink = document.querySelector(SIDEBAR_LINK_SELECTOR)
    if (firstLink) {
      const scrollable = this.findScrollableParent(firstLink as HTMLElement)
      if (scrollable) return scrollable
    }

    const candidates = Array.from(
      document.querySelectorAll("aside, nav, [role='navigation'], [data-orientation='vertical']"),
    ) as HTMLElement[]

    for (const candidate of candidates) {
      const scrollable =
        this.findScrollableParent(candidate) || this.resolveScrollableSelf(candidate)
      if (scrollable) return scrollable
    }

    return null
  }

  extractOutline(maxLevel = 6, includeUserQueries = false, showWordCount = false): OutlineItem[] {
    const turns = Array.from(document.querySelectorAll(TURN_SELECTOR))
    if (turns.length === 0) return []

    const outline: OutlineItem[] = []

    const findNextAssistantMarkdown = (startIndex: number): Element | null => {
      for (let i = startIndex + 1; i < turns.length; i += 1) {
        const candidate = turns[i]
        if (!(candidate instanceof HTMLElement) || !candidate.matches(ASSISTANT_TURN_SELECTOR))
          continue

        const markdown = candidate.querySelector(ASSISTANT_MARKDOWN_SELECTOR)
        if (markdown) return markdown
      }

      return null
    }

    turns.forEach((turn, index) => {
      if (!(turn instanceof HTMLElement)) return

      if (includeUserQueries && turn.matches(USER_TURN_SELECTOR)) {
        const bubble = this.findUserBubble(turn)
        const text = bubble
          ? this.extractUserQueryMarkdown(bubble)
          : this.extractUserQueryMarkdown(turn)
        if (text) {
          const nextAssistant = findNextAssistantMarkdown(index)
          outline.push({
            level: 0,
            text:
              text.length > MAX_OUTLINE_TEXT_LENGTH
                ? `${text.slice(0, MAX_OUTLINE_TEXT_LENGTH)}...`
                : text,
            element: bubble || turn,
            isUserQuery: true,
            isTruncated: text.length > MAX_OUTLINE_TEXT_LENGTH,
            wordCount: showWordCount ? nextAssistant?.textContent?.trim().length || 0 : undefined,
          })
        }
      }

      if (!turn.matches(ASSISTANT_TURN_SELECTOR)) return

      const markdownRoots = Array.from(turn.querySelectorAll(ASSISTANT_MARKDOWN_SELECTOR))
      markdownRoots.forEach((markdownRoot) => {
        const headings = Array.from(markdownRoot.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        headings.forEach((heading, headingIndex) => {
          const level = Number.parseInt(heading.tagName.slice(1), 10)
          if (Number.isNaN(level) || level > maxLevel) return

          const text = heading.textContent?.trim() || ""
          if (!text) return

          let wordCount: number | undefined
          if (showWordCount) {
            let nextBoundary: Element | null = null
            for (let i = headingIndex + 1; i < headings.length; i += 1) {
              const candidate = headings[i]
              const candidateLevel = Number.parseInt(candidate.tagName.slice(1), 10)
              if (!Number.isNaN(candidateLevel) && candidateLevel <= level) {
                nextBoundary = candidate
                break
              }
            }

            wordCount = this.calculateRangeWordCount(heading, nextBoundary, markdownRoot)
          }

          outline.push({
            level,
            text,
            element: heading,
            wordCount,
          })
        })
      })
    })

    return outline
  }

  isGenerating(): boolean {
    return document.querySelector(GENERATING_SELECTOR) !== null
  }

  private extractConversationInfo(link: HTMLAnchorElement): ConversationInfo | null {
    const href = link.getAttribute("href") || ""
    const id = href.match(CHAT_PATH_PATTERN)?.[1]?.trim()
    if (!id || id === "new") return null

    const title = this.extractConversationTitle(link)
    return {
      id,
      title: title || id,
      url: new URL(href, window.location.origin).href,
      isActive:
        link.getAttribute("aria-current") === "page" ||
        this.getSessionId() === id ||
        link.className.includes("bg-fill-white"),
    }
  }

  private extractConversationTitle(link: HTMLAnchorElement): string {
    const titleElement = this.findConversationTitleElement(link)
    const raw = (
      titleElement?.getAttribute("title") ||
      titleElement?.textContent ||
      link.getAttribute("title") ||
      link.textContent ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()

    return raw
  }

  private findConversationTitleElement(root: HTMLElement): HTMLElement | null {
    const candidates = Array.from(root.querySelectorAll("span, div, p")) as HTMLElement[]
    return candidates.find((candidate) => (candidate.textContent || "").trim().length > 0) || null
  }

  private findUserBubble(element: Element): HTMLElement | null {
    if (element instanceof HTMLElement && element.matches('[class*="claw-bubble"]')) {
      return element
    }

    return element.querySelector('[class*="claw-bubble"]') as HTMLElement | null
  }

  private findScrollableParent(start: HTMLElement | null): HTMLElement | null {
    let current = start

    while (current && current !== document.body) {
      const scrollable = this.resolveScrollableSelf(current)
      if (scrollable) return scrollable
      current = current.parentElement
    }

    return null
  }

  private resolveScrollableSelf(element: HTMLElement): HTMLElement | null {
    const style = window.getComputedStyle(element)
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      element.scrollHeight > element.clientHeight
    ) {
      return element
    }

    return null
  }
}
