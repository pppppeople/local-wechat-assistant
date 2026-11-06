'use strict';
const FORMATS = ['plain', 'email', 'letter', 'postcard', 'bulletin', 'news'];
function validateRelayFormat(format, mode) {
 const selected = format || 'plain';
 if (!FORMATS.includes(selected)) throw Error('不支持这个传话格式；可选邮件、信件、明信片、公告、新闻播报');
 if (selected !== 'plain' && mode !== 'relay') throw Error('传话格式只用于固定对象的微信转告，不能替代提醒或真实邮件发送');
 return selected;
}
function formatRelayMessage(format, { sender, recipient, body }) {
 const selected=validateRelayFormat(format,'relay');
 switch(selected) {
 case 'email': return `【微信邮件】\n主题：来自${sender}的消息\n发件人：${sender}\n收件人：${recipient}\n\n${recipient}：\n${body}\n\n${sender}`;
 case 'letter': return `致${recipient}：\n\n${body}\n\n——${sender}`;
 case 'postcard': return `【文字明信片】\n寄给：${recipient}\n\n${body}\n\n寄信人：${sender}`;
 case 'bulletin': return `【日常公告】\n发布人：${sender}\n接收人：${recipient}\n\n${body}`;
 case 'news': return `【生活新闻播报】\n本条消息来自${sender}，送给${recipient}：\n\n${body}\n\n本条播报结束。`;
 default: return body;
 }
}
module.exports={FORMATS,validateRelayFormat,formatRelayMessage};
