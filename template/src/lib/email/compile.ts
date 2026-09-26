import mjml2html from 'mjml'

const stripHtmlTags = (html: string): string =>
	html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s{2,}/g, ' ')
		.replace(/\n{3,}/g, '\n\n')
		.trim()

export const compile = async (
	mjmlString: string,
): Promise<{ html: string; text: string }> => {
	const { html, errors } = await mjml2html(mjmlString, {
		validationLevel: 'strict',
	})
	if (errors && errors.length > 0) {
		throw new Error(errors.map((e) => e.formattedMessage).join('\n'))
	}
	return { html, text: stripHtmlTags(html) }
}
