import { visit } from 'unist-util-visit'

const hatKlasse = (knoten, klasse) => {
	const klassen = knoten?.data?.hProperties?.className
	return Array.isArray(klassen) && klassen.includes(klasse)
}

// Läuft NACH shipyards remarkAdmonitions: das schreibt seit 0.9 immer den Vorgabetitel statt des geschriebenen.
export const remarkAdmonitionLabels = () => (tree) => {
	visit(tree, 'containerDirective', (node) => {
		const [ueberschrift, rumpf] = node.children ?? []
		if (
			!hatKlasse(ueberschrift, 'admonition-heading') ||
			!hatKlasse(rumpf, 'admonition-content')
		) {
			return
		}
		const [erstes] = rumpf.children ?? []
		if (erstes?.type !== 'paragraph' || !erstes.data?.directiveLabel) {
			return
		}
		const label = (erstes.children ?? [])
			.map((kind) => ('value' in kind ? kind.value : ''))
			.join('')
			.trim()
		if (!label) {
			return
		}
		ueberschrift.children = [{ type: 'text', value: label }]
		rumpf.children = rumpf.children.slice(1)
	})
}

export default remarkAdmonitionLabels
