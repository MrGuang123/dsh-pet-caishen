export async function mountCharacter(container) {
  const response = await fetch('/assets/acai.svg', { credentials: 'same-origin' });
  if (!response.ok) throw new Error('阿财的形象暂时加载失败');
  const document = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'svg') {
    throw new Error('阿财的形象文件无法读取');
  }
  // The artwork is an application-owned local asset, never model or bridge content.
  container.replaceChildren(container.ownerDocument.importNode(document.documentElement, true));
}
