function joinText(parts, select) {
    return Array.isArray(parts) ? parts.map(select).filter(text => typeof text === 'string').join('') : '';
}

function textFromThinkingBlock(block) {
    if (block?.thought === true) return block.text;
    if (block?.type === 'thinking') {
        return typeof block.thinking === 'string' ? block.thinking : joinText(block.thinking, part => part?.text);
    }
    return '';
}

export function extractVisibleReasoning(data) {
    const choice = data?.choices?.[0];
    const message = choice?.delta ?? choice?.message ?? data?.delta;
    const direct = [message?.reasoning_content, message?.reasoning, message?.thinking,
        choice?.reasoning, data?.reasoning_content, data?.reasoning, data?.thinking]
        .find(text => typeof text === 'string' && text.length);
    if (direct) return direct;

    const details = joinText(message?.reasoning_details, detail => {
        if (detail?.type === 'reasoning.text') return detail.text;
        if (detail?.type === 'reasoning.summary') return detail.summary;
        return '';
    });
    if (details) return details;

    return textFromThinkingBlock(data?.content_block)
        || joinText(message?.content, textFromThinkingBlock)
        || joinText(data?.content, textFromThinkingBlock)
        || joinText(data?.candidates?.[0]?.content?.parts ?? data?.responseContent?.parts, textFromThinkingBlock);
}
