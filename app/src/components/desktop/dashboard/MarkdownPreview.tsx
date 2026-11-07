import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { open } from '@tauri-apps/plugin-shell';
import { toast } from 'sonner';
import i18n from '../../../i18n';
import './markdown-preview.css';

// Do not resolve document-relative URLs, local/asset paths, data URLs or
// protocol-relative URLs against the app's privileged origin.
function safeLink(value: string): string | undefined {
    if (!/^(https?:\/\/|mailto:)/i.test(value)) return undefined;
    try {
        const url = new URL(value);
        if (url.protocol !== 'mailto:' && (!url.hostname || url.username || url.password)) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

const plugins = [remarkGfm];

export default function MarkdownPreview({ content }: { content: string }) {
    return (
        <div role="region" aria-label={i18n.t('viewer.markdown_preview_region')} tabIndex={0}
            className="markdown-preview custom-scrollbar min-h-0 flex-1 overflow-auto p-6 text-white">
            <ReactMarkdown
                remarkPlugins={plugins}
                skipHtml
                urlTransform={(url, key) => key === 'href' ? safeLink(url) : undefined}
                components={{
                    // Images are deliberately text-only, even for HTTPS sources:
                    // rendering protected documents must not leak a network request.
                    img: ({ alt }) => <span className="markdown-image">{i18n.t('viewer.markdown_image_blocked', { alt: alt || i18n.t('viewer.markdown_image') })}</span>,
                    a: ({ href, children }) => {
                        const url = href && safeLink(href);
                        if (!url) return <span>{children}</span>;
                        return <a href={url} rel="noreferrer noopener" onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                            void open(url).catch(() => toast.error(i18n.t('common.operation_failed')));
                        }}>{children}</a>;
                    },
                }}
            >{content}</ReactMarkdown>
        </div>
    );
}
