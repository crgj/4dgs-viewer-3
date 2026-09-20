// #WDD-gpt 2026-09-19 - 独立挂载观赏页面，不挂载编辑器、插件面板或编辑快捷键。
import { createRoot } from 'react-dom/client';
import { ShowDance } from './ShowDance';
import './show-dance.css';
createRoot(document.getElementById('root')!).render(<ShowDance />);
