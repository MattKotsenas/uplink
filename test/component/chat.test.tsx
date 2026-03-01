import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { h } from 'preact';
import { Conversation } from '../../src/client/conversation.js';
import { ChatList, renderMarkdown } from '../../src/client/ui/chat.js';

afterEach(cleanup);

describe('renderMarkdown', () => {
  it('escapes HTML entities', () => {
    const result = renderMarkdown('<script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('renders inline code', () => {
    expect(renderMarkdown('use `foo()` here')).toContain('<code>foo()</code>');
  });

  it('renders bold text', () => {
    expect(renderMarkdown('this is **bold**')).toContain('<strong>bold</strong>');
  });

  it('renders italic text', () => {
    expect(renderMarkdown('this is *italic*')).toContain('<em>italic</em>');
  });

  it('renders links', () => {
    const result = renderMarkdown('[click](https://example.com)');
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('>click</a>');
  });

  it('rejects non-http links', () => {
    const result = renderMarkdown('[bad](javascript:alert(1))');
    expect(result).not.toContain('href=');
    expect(result).toContain('bad');
  });

  it('renders fenced code blocks', () => {
    const md = '```js\nconst x = 1;\n```';
    const result = renderMarkdown(md);
    expect(result).toContain('<pre><code');
    expect(result).toContain('language-js');
  });

  it('renders plain code blocks without lang', () => {
    const md = '```\nhello\n```';
    const result = renderMarkdown(md);
    expect(result).toContain('<pre><code>');
    expect(result).toContain('hello');
  });

  it('renders tables', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |';
    const result = renderMarkdown(md);
    expect(result).toContain('<table>');
    expect(result).toContain('<th>');
    expect(result).toContain('Name');
    expect(result).toContain('<td>');
    expect(result).toContain('Alice');
  });

  it('renders unordered lists', () => {
    const md = '- one\n- two\n- three';
    const result = renderMarkdown(md);
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>');
    expect(result).toContain('one');
  });

  it('renders blockquotes', () => {
    const md = '> hello world';
    const result = renderMarkdown(md);
    expect(result).toContain('<blockquote>');
    expect(result).toContain('hello world');
  });

  it('renders headings', () => {
    const result = renderMarkdown('## Heading');
    expect(result).toContain('<h2');
    expect(result).toContain('Heading');
  });
});

describe('ChatList', () => {
  it('renders user and agent messages', () => {
    const conv = new Conversation();
    conv.addUserMessage('Hello');
    conv.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hi there!' },
    });

    const scrollContainer = document.createElement('div');
    const { container } = render(
      <ChatList conversation={conv} scrollContainer={scrollContainer} />,
    );

    const messages = container.querySelectorAll('.message');
    expect(messages.length).toBe(2);
    expect(messages[0].classList.contains('user')).toBe(true);
    expect(messages[1].classList.contains('agent')).toBe(true);
    expect(messages[0].textContent).toContain('Hello');
    expect(messages[1].textContent).toContain('Hi there!');
  });

  it('updates on streaming chunks', () => {
    const conv = new Conversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'First' },
    });

    const scrollContainer = document.createElement('div');
    const { container } = render(
      <ChatList conversation={conv} scrollContainer={scrollContainer} />,
    );

    expect(container.textContent).toContain('First');

    act(() => {
      conv.handleSessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Second' },
      });
    });

    expect(container.textContent).toContain('First Second');
  });

  it('renders markdown in messages', () => {
    const conv = new Conversation();
    conv.handleSessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Use **bold** and `code`' },
    });

    const scrollContainer = document.createElement('div');
    const { container } = render(
      <ChatList conversation={conv} scrollContainer={scrollContainer} />,
    );

    const content = container.querySelector('.content')!;
    expect(content.innerHTML).toContain('<strong>bold</strong>');
    expect(content.innerHTML).toContain('<code>code</code>');
  });

  it('renders empty when no messages', () => {
    const conv = new Conversation();
    const scrollContainer = document.createElement('div');
    const { container } = render(
      <ChatList conversation={conv} scrollContainer={scrollContainer} />,
    );

    expect(container.querySelectorAll('.message').length).toBe(0);
  });

  it('shows thinking dots when prompting', () => {
    const conv = new Conversation();
    conv.addUserMessage('hello');
    conv.isPrompting = true;

    const scrollContainer = document.createElement('div');
    const { container } = render(
      <ChatList conversation={conv} scrollContainer={scrollContainer} />,
    );

    expect(container.querySelector('.thinking-dots')).toBeTruthy();
  });
});
