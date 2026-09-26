import { visit } from 'unist-util-visit'

// remarkAdmonitions aus shipyard liest `node.label`, remark-directive legt den Titel aber als ersten Absatz ab.
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
