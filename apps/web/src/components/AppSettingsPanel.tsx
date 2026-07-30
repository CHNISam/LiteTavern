import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Download,
  ExternalLink,
  HeartHandshake,
  Info,
  MessageCircle,
  Upload,
  UserRound,
  X
} from 'lucide-react';
import { EXPORT_PATH } from '../lib/cloud';
import { APP_VERSION, githubUrl } from '../lib/project-links';
import { cloudUrl } from '../lib/runtime-config';
import { siteHref } from '../public-routing';

interface AppSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onImport: () => void;
  onMigrate: () => void;
  onPersonas: () => void;
  onWorldbooks: () => void;
}

type SettingsView = 'root' | 'data' | 'about';

export function AppSettingsPanel({
  open,
  onClose,
  onImport,
  onMigrate,
  onPersonas,
  onWorldbooks
}: AppSettingsPanelProps) {
  const [view, setView] = useState<SettingsView>('root');

  useEffect(() => {
    if (!open) setView('root');
  }, [open]);

  if (!open) return null;

  const title =
    view === 'data'
      ? '数据导入与迁移'
      : view === 'about'
        ? '关于 LiteTavern'
        : '设置';

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="app-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="app-settings-header">
          {/* Grid rows, not inline flow: the back control and the eyebrow used to
              run together on one line and collide. On a sub-view the back control
              replaces the eyebrow rather than stacking with it. */}
          <div className="app-settings-heading">
            {view === 'root' ? (
              <span className="eyebrow">LiteTavern</span>
            ) : (
              <button
                type="button"
                className="app-settings-back"
                aria-label="返回设置"
                onClick={() => setView('root')}
              >
                <ArrowLeft size={17} /> 返回设置
              </button>
            )}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="app-settings-body">
          {view === 'root' && (
            <nav className="app-settings-list" aria-label="设置项目">
              <button type="button" onClick={onPersonas}>
                <span className="app-settings-icon"><UserRound size={19} /></span>
                <span>
                  <strong>用户身份</strong>
                  <small>管理你在故事中的 Persona，与账号资料无关</small>
                </span>
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={onWorldbooks}>
                <span className="app-settings-icon"><BookOpen size={19} /></span>
                <span>
                  <strong>世界书</strong>
                  <small>管理世界设定条目，命中时才进入对话</small>
                </span>
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={() => setView('data')}>
                <span className="app-settings-icon"><Upload size={19} /></span>
                <span>
                  <strong>数据导入与迁移</strong>
                  <small>导入角色卡、迁移角色关系或导出云端数据</small>
                </span>
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={() => setView('about')}>
                <span className="app-settings-icon"><Info size={19} /></span>
                <span>
                  <strong>关于 LiteTavern</strong>
                  <small>版本、开源仓库，以及自愿支持入口</small>
                </span>
                <ChevronRight size={18} />
              </button>
            </nav>
          )}

          {view === 'data' && (
            <>
              <p className="app-settings-lead">
                在这里处理低频的数据操作；新建角色仍从联系人栏开始。
              </p>
              <div className="app-settings-list">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onImport();
                  }}
                >
                  <span className="app-settings-icon"><Upload size={19} /></span>
                  <span>
                    <strong>导入角色卡</strong>
                    <small>从本地 JSON 或 PNG 创建角色</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onMigrate();
                  }}
                >
                  <span className="app-settings-icon"><HeartHandshake size={19} /></span>
                  <span>
                    <strong>迁移角色关系</strong>
                    <small>导入其他平台的关系、资料与记忆</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
                <a href={cloudUrl(EXPORT_PATH)} download>
                  <span className="app-settings-icon"><Download size={19} /></span>
                  <span>
                    <strong>导出云端数据</strong>
                    <small>下载当前 Cloud 账号的数据副本</small>
                  </span>
                  <ChevronRight size={18} />
                </a>
              </div>
            </>
          )}

          {view === 'about' && (
            // Self-contained: this panel used to hand off to /about, which showed
            // the same thing again and pushed another page onto the stack.
            <div className="app-about">
              <div className="app-about-identity">
                <span className="app-about-mark"><MessageCircle size={25} /></span>
                <div>
                  <h3>LiteTavern</h3>
                  <span className="app-about-version">版本 {APP_VERSION}</span>
                </div>
              </div>
              <p>一个让角色、对话与共同经历持续延续的开源 AI 客户端。</p>
              <a
                className="app-about-link"
                href={githubUrl()}
                target="_blank"
                rel="noopener noreferrer"
              >
                在 GitHub 上查看源码 <ExternalLink size={15} />
              </a>
              <section>
                <h4>支持 LiteTavern</h4>
                <p>
                  支持属于低频、自愿贡献，不影响正常使用、Cloud 注册、同步、套餐或
                  Alpha 资格。
                </p>
                <a
                  className="secondary-button"
                  href={siteHref('/support?source=website&placement=about')}
                >
                  支持 LiteTavern <ChevronRight size={17} />
                </a>
              </section>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
