import { SITE_IDS } from "~constants"
import { htmlToMarkdown } from "~utils/exporter"

import {
  SiteAdapter,
  type ConversationInfo,
  type ConversationObserverConfig,
  type ExportConfig,
  type NetworkMonitorConfig,
  type OutlineItem,
} from "./base"

const HOSTNAMES = new Set(["www.perplexity.ai", "perplexity.ai"])
const THREAD_PATH_PATTERN = /^\/(?:search|page)\/([^/?#]+)(?:\/|$)/i
const NEW_THREAD_PATH_PATTERN = /^\/search\/new(?:\/|$)/i

const TEXTAREA_SELECTORS = [
  "#ask-input",
  'div[contenteditable="true"][role="textbox"]:not([id])',
  'div[contenteditable="true"][g_editable="true"]',
  'div[contenteditable="true"][data-lexical-editor="true"]',
  'div[contenteditable="true"][role="textbox"]',
]

const SUBMIT_BUTTON_SELECTOR = 'button[data-testid="submit-button"], button[type="submit"]'
const STOP_BUTTON_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop" i]'
const NEW_CHAT_BUTTON_SELECTORS = [
  'a[href="/"]',
  'a[href="/search/new"]',
  'button[data-testid="new-thread-button"]',
]

const USER_QUERY_SELECTOR = [
  ".group\\/query",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs",
].join(", ")

const USER_QUERY_CONTENT_SELECTOR = [
  ".group\\/query .whitespace-pre-wrap",
  ".group\\/query [dir='auto']",
  ".group\\/query p",
  ".group\\/query [data-lexical-text='true']",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs .whitespace-pre-wrap",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs [dir='auto']",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs p",
  "[role='tabpanel'] .group.relative.flex.items-end.mb-xs [data-lexical-text='true']",
].join(", ")

const ASSISTANT_MESSAGE_SELECTOR = [
  "div[id*='markdown-content-']",
  "div[id*='Markdown-Content-']",
].join(", ")

const RESPONSE_CONTAINER_SELECTOR = [
  "[role='tabpanel']",
  "main [class*='overflow-y-auto']",
  "main [class*='overflow-auto']",
  "main",
].join(", ")

const SIDEBAR_LINK_SELECTOR = "a[href^='/search/'], a[href^='/page/']"
const SIDEBAR_ITEM_CONTAINER_SELECTORS = [
  ".group\\/sidebar-submenu",
  "[data-title-hover='true']",
  "[data-testid='sidebar-item']",
  "li",
  "[role='listitem']",
].join(", ")
const SIDEBAR_SCROLL_CONTAINER_SELECTORS = [".group\\/sidebar", "aside", "nav"]
const THREAD_TITLE_SELECTOR =
  ".h-headerHeight.fixed.z-10 .cursor-pointer.transition.duration-300.hover\\:opacity-70, input[placeholder='Untitled']"

function buildPerplexityUrl(pathname: string): string {
  const origin = HOSTNAMES.has(window.location.hostname)
    ? window.location.origin
    : "https://www.perplexity.ai"
  return new URL(pathname, origin).toString()
}

export class PerplexityAdapter extends SiteAdapter {
  match(): boolean {
    return HOSTNAMES.has(window.location.hostname)
  }

  getSiteId(): string {
    return SITE_IDS.PERPLEXITY
  }

  getName(): string {
    return "Perplexity"
  }

  getThemeColors(): { primary: string; secondary: string } {
    return { primary: "#1fb8cd", secondary: "#1597aa" }
  }

  getNewTabUrl(): string {
    return "https://www.perplexity.ai/"
  }

  getSessionId(): string {
    const slug = window.location.pathname.match(THREAD_PATH_PATTERN)?.[1]?.trim() || ""
    return slug === "new" ? "" : slug
  }

  isNewConversation(): boolean {
    const path = window.location.pathname.replace(/\/+$/, "") || "/"
    return path === "/" || NEW_THREAD_PATH_PATTERN.test(path) || !THREAD_PATH_PATTERN.test(path)
  }

  getSessionName(): string | null {
    const title = document.title.trim()
    if (!title || /^perplexity(?: ai)?$/i.test(title)) return null

    const cleaned = title.replace(/\s*[-|]\s*Perplexity(?: AI)?$/i, "").trim()
    return cleaned && !/^perplexity(?: ai)?$/i.test(cleaned) ? cleaned : null
  }

  getConversationTitle(): string | null {
    const sessionId = this.getSessionId()
    if (sessionId) {
      const sidebarTitle = this.getSidebarConversationTitle(sessionId)
      if (sidebarTitle) return sidebarTitle
    }

    const titleElement = document.querySelector(THREAD_TITLE_SELECTOR)
    const title =
      titleElement instanceof HTMLInputElement
        ? titleElement.value.trim()
        : titleElement?.textContent?.trim() || ""

    return this.normalizeConversationTitle(title, sessionId) || this.getSessionName()
  }

  getCurrentConversationInfo(): ConversationInfo | null {
    const id = this.getSessionId()
    if (!id || this.isNewConversation()) return null

    return {
      id,
      title: this.getConversationTitle() || id,
      url: buildPerplexityUrl(`/search/${id}`),
      isActive: true,
    }
  }

  getConversationList(): ConversationInfo[] {
    const result = new Map<string, ConversationInfo>()
    this.getNativeSidebarConversationLinks().forEach((link) => {
      const info = this.extractConversationInfo(link)
      if (info) result.set(info.id, info)
    })

    const current = this.getCurrentConversationInfo()
    if (current) result.set(current.id, current)

    return Array.from(result.values())
  }

  getConversationObserverConfig(): ConversationObserverConfig {
    return {
      selector: SIDEBAR_LINK_SELECTOR,
      shadow: false,
      extractInfo: (element) => this.extractConversationInfo(element),
      getTitleElement: (element) => this.findConversationItemContainer(element) || element,
    }
  }

  getSidebarScrollContainer(): Element | null {
    for (const selector of SIDEBAR_SCROLL_CONTAINER_SELECTORS) {
      const candidate = document.querySelector(selector)
      if (!(candidate instanceof HTMLElement) || this.isElementInsideOphel(candidate)) continue

      const scrollable = this.findScrollableParent(candidate)
      return scrollable || candidate
    }

    return null
  }

  navigateToConversation(id: string, url?: string): boolean {
    const link = this.findSidebarConversationLink(id)
    if (link) {
      link.click()
      return true
    }

    return super.navigateToConversation(id, url || buildPerplexityUrl(`/search/${id}`))
  }

  getTextareaSelectors(): string[] {
    return [...TEXTAREA_SELECTORS]
  }

  isValidTextarea(element: HTMLElement): boolean {
    if (!super.isValidTextarea(element)) return false
    if (element.id === "ask-input") return true
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) return true

    return (
      element.isContentEditable &&
      (element.getAttribute("role") === "textbox" ||
        element.getAttribute("g_editable") === "true" ||
        element.closest("form") !== null)
    )
  }

  insertPrompt(content: string): boolean {
    const editor = this.getTextareaElement()
    if (!editor || !editor.isConnected) return false

    editor.focus()

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      this.setTextEntryValue(editor, content)
      editor.dispatchEvent(
        new InputEvent("input", { bubbles: true, composed: true, data: content }),
      )
      editor.dispatchEvent(new Event("change", { bubbles: true }))
      if (editor instanceof HTMLTextAreaElement) {
        editor.setSelectionRange(content.length, content.length)
      }
      return true
    }

    this.selectEditorContents(editor)
    try {
      document.execCommand("delete", false)
      if (document.execCommand("insertText", false, content)) {
        this.dispatchEditorInputEvents(editor, content, "insertText")
        this.placeCaretAtEnd(editor)
        return true
      }
    } catch {
      // Some browsers/userscript sandboxes reject execCommand; textContent fallback follows.
    }

    editor.textContent = content
    this.dispatchEditorInputEvents(editor, content, "insertText")
    this.placeCaretAtEnd(editor)
    return true
  }

  clearTextarea(): void {
    const editor = this.getTextareaElement()
    if (!editor || !editor.isConnected) return

    editor.focus()

    if (editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement) {
      this.setTextEntryValue(editor, "")
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: "" }))
      editor.dispatchEvent(new Event("change", { bubbles: true }))
      if (editor instanceof HTMLTextAreaElement) {
        editor.setSelectionRange(0, 0)
      }
      return
    }

    this.selectEditorContents(editor)
    try {
      document.execCommand("delete", false)
    } catch {
      editor.textContent = ""
    }
    this.dispatchEditorInputEvents(editor, "", "deleteContentBackward")
    this.placeCaretAtEnd(editor)
  }

  getSubmitButtonSelectors(): string[] {
    return [`${SUBMIT_BUTTON_SELECTOR}:not([disabled])`]
  }

  getNewChatButtonSelectors(): string[] {
    return [...NEW_CHAT_BUTTON_SELECTORS]
  }

  isGenerating(): boolean {
    const stopButton = document.querySelector(STOP_BUTTON_SELECTOR) as HTMLElement | null
    return Boolean(
      stopButton && this.isVisibleElement(stopButton) && !stopButton.hasAttribute("disabled"),
    )
  }

  getStopButtonSelectors(): string[] {
    return [STOP_BUTTON_SELECTOR]
  }

  getNetworkMonitorConfig(): NetworkMonitorConfig {
    return {
      urlPatterns: ["/rest/sse/perplexity_ask"],
      silenceThreshold: 2500,
    }
  }

  getResponseContainerSelector(): string {
    return RESPONSE_CONTAINER_SELECTOR
  }

  getChatContentSelectors(): string[] {
    return [USER_QUERY_SELECTOR, ASSISTANT_MESSAGE_SELECTOR]
  }

  getUserQuerySelector(): string | null {
    return USER_QUERY_SELECTOR
  }

  extractUserQueryText(element: Element): string {
    const root = this.findUserQueryContentRoot(element)
    return root ? this.extractTextWithLineBreaks(root).trim() : ""
  }

  extractUserQueryMarkdown(element: Element): string {
    const root = this.findUserQueryContentRoot(element)
    if (!root) return ""

    const clone = root.cloneNode(true) as HTMLElement
    this.removeNonContentNodes(clone)
    return (htmlToMarkdown(clone) || this.extractTextWithLineBreaks(clone)).trim()
  }

  extractAssistantResponseText(element: Element): string {
    const clone = element.cloneNode(true) as HTMLElement
    this.removeNonContentNodes(clone)
    return (htmlToMarkdown(clone) || this.extractTextWithLineBreaks(clone)).trim()
  }

  getExportConfig(): ExportConfig {
    return {
      userQuerySelector: USER_QUERY_SELECTOR,
      assistantResponseSelector: ASSISTANT_MESSAGE_SELECTOR,
      turnSelector: null,
      useShadowDOM: false,
    }
  }

  extractOutline(maxLevel = 6, includeUserQueries = false, showWordCount = false): OutlineItem[] {
    const container = document.querySelector(this.getResponseContainerSelector())
    if (!container) return []

    const headingSelector = Array.from({ length: maxLevel }, (_, index) => `h${index + 1}`).join(
      ", ",
    )
    const selector = includeUserQueries
      ? `${USER_QUERY_SELECTOR}, ${headingSelector}`
      : headingSelector
    const elements = Array.from(container.querySelectorAll(selector)).filter(
      (element) =>
        !element.closest(".gh-root, .gh-user-query-markdown") &&
        (element instanceof HTMLElement ? this.isVisibleElement(element) : true),
    )

    const topLevel = this.collectTopLevelBlocks(elements)
    return topLevel
      .map((element, index) => {
        const isUserQuery = element.matches(USER_QUERY_SELECTOR)
        const tagName = element.tagName.toLowerCase()
        const level = isUserQuery ? 0 : Number(tagName.replace("h", ""))
        if (!isUserQuery && (!Number.isFinite(level) || level < 1 || level > maxLevel)) return null

        const fullText = isUserQuery
          ? this.extractUserQueryText(element)
          : element.textContent?.replace(/\s+/g, " ").trim() || ""
        if (!fullText) return null

        const item: OutlineItem = {
          level,
          text: fullText.length > 120 ? `${fullText.slice(0, 120)}...` : fullText,
          element,
          isUserQuery,
          isTruncated: fullText.length > 120,
        }

        if (showWordCount) {
          const next = topLevel[index + 1] || null
          item.wordCount = this.calculateRangeWordCount(element, next, container)
        }

        return item
      })
      .filter((item): item is OutlineItem => Boolean(item))
  }

  private parseThreadSlugFromUrl(url: string): string {
    try {
      const slug =
        new URL(url, window.location.origin).pathname.match(THREAD_PATH_PATTERN)?.[1] || ""
      return slug === "new" ? "" : slug.trim()
    } catch {
      return ""
    }
  }

  private extractConversationInfo(element: Element): ConversationInfo | null {
    const anchor = (
      element instanceof HTMLAnchorElement
        ? element
        : element.closest("a") || element.querySelector(SIDEBAR_LINK_SELECTOR)
    ) as HTMLAnchorElement | null
    if (!this.isNativeSidebarConversationLink(anchor)) return null

    const slug = this.parseThreadSlugFromUrl(anchor.getAttribute("href") || anchor.href || "")
    if (!slug) return null

    return {
      id: slug,
      title: this.extractConversationTitle(anchor, slug),
      url: new URL(anchor.getAttribute("href") || anchor.href, window.location.origin).toString(),
      isActive: slug === this.getSessionId(),
    }
  }

  private getNativeSidebarConversationLinks(): HTMLAnchorElement[] {
    const root = this.getNativeSidebarRoot()
    if (!root) return []

    const links = Array.from(root.querySelectorAll(SIDEBAR_LINK_SELECTOR))
    return links.filter((link): link is HTMLAnchorElement =>
      this.isNativeSidebarConversationLink(link as HTMLAnchorElement | null),
    )
  }

  private getNativeSidebarRoot(): ParentNode | null {
    const roots = [
      this.getSidebarScrollContainer(),
      document.querySelector(".group\\/sidebar"),
      document.querySelector("aside"),
      document.querySelector("nav"),
    ].filter(Boolean) as Element[]

    for (const root of roots) {
      if (!this.isElementInsideOphel(root) && root.querySelector(SIDEBAR_LINK_SELECTOR)) return root
    }

    return null
  }

  private isNativeSidebarConversationLink(
    anchor: HTMLAnchorElement | null,
  ): anchor is HTMLAnchorElement {
    if (!(anchor instanceof HTMLAnchorElement) || !anchor.isConnected) return false
    if (this.isElementInsideOphel(anchor)) return false
    if (!this.parseThreadSlugFromUrl(anchor.getAttribute("href") || anchor.href || "")) return false

    const row = anchor.closest(SIDEBAR_ITEM_CONTAINER_SELECTORS)
    return Boolean(row && !this.isElementInsideOphel(row))
  }

  private findSidebarConversationLink(id: string): HTMLAnchorElement | null {
    return (
      this.getNativeSidebarConversationLinks().find(
        (link) => this.parseThreadSlugFromUrl(link.getAttribute("href") || link.href || "") === id,
      ) || null
    )
  }

  private getSidebarConversationTitle(id: string): string | null {
    const link = this.findSidebarConversationLink(id)
    return link ? this.extractConversationTitle(link, id) : null
  }

  private extractConversationTitle(anchor: HTMLAnchorElement, slug: string): string {
    const row = this.findConversationItemContainer(anchor)
    const candidates = [
      ...Array.from(
        (row || anchor).querySelectorAll("[data-testid*='title'], [dir='auto'], .truncate, span"),
      ),
      anchor,
      row,
    ].filter(Boolean) as Element[]

    const title =
      candidates
        .map((candidate) => this.normalizeConversationTitle(candidate.textContent || "", slug))
        .filter(Boolean)
        .sort(
          (a, b) =>
            this.scoreConversationTitleCandidate(b, slug) -
            this.scoreConversationTitleCandidate(a, slug),
        )[0] ||
      this.normalizeConversationTitle(
        anchor.getAttribute("title") || anchor.getAttribute("aria-label") || "",
        slug,
      )

    return title || slug
  }

  private normalizeConversationTitle(rawTitle: string, slug = ""): string {
    const normalized = rawTitle
      .replace(/\s+/g, " ")
      .replace(
        /(?:Rename|Delete|More|menu|\u91cd\u547d\u540d|\u5220\u9664|\u66f4\u591a|\u83dc\u5355)+$/giu,
        "",
      )
      .trim()
    if (
      !normalized ||
      normalized === "/" ||
      normalized === "..." ||
      normalized === "\u00b7\u00b7\u00b7"
    )
      return ""
    if (/^\(\d+\)$/.test(normalized)) return ""
    if (normalized === slug) return slug
    return normalized
  }

  private scoreConversationTitleCandidate(title: string, slug: string): number {
    let score = 0
    if (!this.isLikelySlugTitle(title, slug)) score += 100
    if (/\s/.test(title)) score += 15
    score += Math.min(title.length, 80)
    if (title.length > 120) score -= 30
    return score
  }

  private isLikelySlugTitle(title: string, slug?: string): boolean {
    const normalized = title.trim().toLowerCase()
    if (!normalized) return true
    if (slug && normalized === slug.trim().toLowerCase()) return true
    return /^[a-z0-9]+(?:-[a-z0-9]+){2,}(?:-[a-z0-9_-]{4,})?$/i.test(normalized)
  }

  private findConversationItemContainer(anchor: Element | null): HTMLElement | null {
    if (!(anchor instanceof HTMLElement)) return null
    return (anchor.closest(SIDEBAR_ITEM_CONTAINER_SELECTORS) ||
      anchor.parentElement) as HTMLElement | null
  }

  private findUserQueryContentRoot(element: Element): Element | null {
    const scope = element.matches(USER_QUERY_SELECTOR)
      ? element
      : element.closest(USER_QUERY_SELECTOR) || element
    return scope.querySelector(USER_QUERY_CONTENT_SELECTOR) || scope
  }

  private removeNonContentNodes(root: HTMLElement): void {
    root
      .querySelectorAll(".gh-root, button, [role='button'], svg, [aria-hidden='true']")
      .forEach((node) => node.remove())
  }

  private collectTopLevelBlocks<T extends Element>(elements: T[]): T[] {
    return elements.filter(
      (element) => !elements.some((other) => other !== element && other.contains(element)),
    )
  }

  private findScrollableParent(element: HTMLElement): HTMLElement | null {
    let current: HTMLElement | null = element
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current)
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        current.scrollHeight > current.clientHeight
      ) {
        return current
      }
      current = current.parentElement
    }
    return null
  }

  private isVisibleElement(element: HTMLElement | null): boolean {
    if (!element) return false
    if (element.offsetParent !== null) return true

    const style = window.getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")
      return false

    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  private isElementInsideOphel(element: Element | null): boolean {
    return Boolean(element?.closest(".gh-root"))
  }

  private setTextEntryValue(editor: HTMLTextAreaElement | HTMLInputElement, value: string): void {
    const prototype =
      editor instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    if (setter) {
      setter.call(editor, value)
    } else {
      editor.value = value
    }
  }

  private selectEditorContents(editor: HTMLElement): void {
    const selection = window.getSelection()
    if (!selection) return

    const range = document.createRange()
    range.selectNodeContents(editor)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  private placeCaretAtEnd(editor: HTMLElement): void {
    const selection = window.getSelection()
    if (!selection) return

    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  private dispatchEditorInputEvents(
    editor: HTMLElement,
    data: string,
    inputType: InputEvent["inputType"],
  ): void {
    editor.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, data, inputType }),
    )
    editor.dispatchEvent(new Event("change", { bubbles: true }))
  }
}
