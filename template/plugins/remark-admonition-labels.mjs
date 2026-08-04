import { visit } from 'unist-util-visit'

/**
 * remark-directive legt den Titel einer Admonition (`:::warning[Titel]`) als
 * erstes Kind-Paragraph mit `data.directiveLabel` ab. `remarkAdmonitions` aus
 * @levino/shipyard-base liest den Titel aber aus `node.label`, das es bei
 * Container-Direktiven gar nicht gibt.
 *
 * Dieses Plugin schliesst die Luecke: es zieht das Label in `node.label` hoch
 * und entfernt den Label-Paragraph aus dem Inhalt. Es muss zwischen
 * `remarkDirective` und `remarkAdmonitions` laufen.
 */
export const remarkAdmonitionLabels = () => (tree) => {
	visit(tree, 'containerDirective', (node) => {
		const [first] = node.children ?? []
		if (!first || first.type !== 'paragraph' || !first.data?.directiveLabel) {
			return
		}
		const label = (first.children ?? [])
			.map((child) => ('value' in child ? child.value : ''))
			.join('')
			.trim()
		if (label) {
			node.label = label
		}
		node.children = node.children.slice(1)
	})
}

export default remarkAdmonitionLabels
