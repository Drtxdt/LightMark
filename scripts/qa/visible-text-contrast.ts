/** Native QA only: computed, visible text colors. Gradients are reported for visual review. */
export function inspectVisibleTextContrast() {
  type Color = [number, number, number, number];
  const parse = (value: string): Color | null => {
    const match = value.match(/^rgba?\(([^)]+)\)$/);
    if (!match) return null;
    const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return parts.length >= 3 ? [parts[0], parts[1], parts[2], parts[3] ?? 1] : null;
  };
  const over = (a: Color, b: Color): Color => {
    const alpha = a[3] + b[3] * (1 - a[3]);
    return [0, 1, 2].map(i => (a[i] * a[3] + b[i] * b[3] * (1 - a[3])) / (alpha || 1)).concat(alpha) as Color;
  };
  const luminance = (color: Color) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const results: Array<Record<string, unknown>> = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let text: Node | null;
  while ((text = walker.nextNode())) {
    const content = text.textContent?.trim();
    const element = text.parentElement;
    if (!content || !element || element.closest('[disabled], [aria-disabled="true"], script, style')) continue;
    const rects = element.getClientRects();
    if (![...rects].some(rect => rect.width && rect.height && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth)) continue;
    const style = getComputedStyle(element);
    if (style.visibility !== 'visible' || style.display === 'none') continue;
    const foreground = parse(style.color);
    if (!foreground) continue;
    const ancestors: HTMLElement[] = [];
    for (let current: HTMLElement | null = element; current; current = current.parentElement) ancestors.unshift(current);
    let background: Color = [255, 255, 255, 1], opacity = 1, image = false;
    for (const parent of ancestors) {
      const css = getComputedStyle(parent), color = parse(css.backgroundColor);
      if (color) background = over(color, background);
      opacity *= Number(css.opacity);
      image ||= css.backgroundImage !== 'none';
    }
    if (opacity === 0) continue;
    foreground[3] *= opacity;
    const ink = over(foreground, background), a = luminance(ink), b = luminance(background);
    const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    results.push({ text: content.slice(0, 100), tag: element.tagName, className: element.className, foreground: style.color, background, ratio, passed: ratio >= 4.5, backgroundImage: image });
  }
  return { viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, dark: document.documentElement.classList.contains('dark'),
    count: results.length, failures: results.filter(item => !item.passed), minimum: Math.min(...results.map(item => item.ratio as number)), results,
    limitation: 'Computed visible text; images, gradients, anti-aliasing, occlusion and native OS surfaces require visual inspection.' };
}
