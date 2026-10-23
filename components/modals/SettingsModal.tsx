import React, { useState } from 'react';
import { Settings, Language } from '../../types';
import { translations } from '../../utils/translations';
import { X, Save, Download, Upload, AlertTriangle, Zap, Globe } from 'lucide-react';

interface SettingsModalProps {
  settings: Settings;
  onSave: (newSettings: Settings) => void;
  onClose: () => void;
  onExport: () => void;
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ settings, onSave, onClose, onExport, onImport }) => {
  const [localSettings, setLocalSettings] = useState<Settings>({
      ...settings,
      showLimitedMenu: !!settings.showLimitedMenu,
      language: settings.language || 'ar'
  });

  const lang = localSettings.language || 'ar';
  const t = translations[lang];

  const toggleSpecialMenu = () => {
    setLocalSettings({ ...localSettings, showLimitedMenu: !localSettings.showLimitedMenu });
  };

  const handleSave = () => {
      onSave(localSettings);
  };

  const isDisabling = settings.showLimitedMenu && !localSettings.showLimitedMenu;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl animate-in fade-in zoom-in duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <span>⚙️</span> {t.settings}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="space-y-6">

          {/* Language Selector */}
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-2 flex items-center gap-2">
                <Globe size={16} className="text-blue-500" />
                {t.language}
            </label>
            <div className="grid grid-cols-3 gap-2">
                {(['ar', 'en', 'pt'] as Language[]).map((l) => (
                    <button
                        key={l}
                        onClick={() => setLocalSettings({...localSettings, language: l})}
                        className={`py-2 px-3 rounded-xl border-2 text-sm font-bold transition-all ${localSettings.language === l ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-100 text-gray-500 hover:bg-gray-50'}`}
                    >
                        {l === 'ar' ? 'العربية' : l === 'en' ? 'English' : 'Português'}
                    </button>
                ))}
            </div>
          </div>

          {/* Special Menu Toggle */}
          <div className={`p-4 rounded-xl border-2 transition-all ${localSettings.showLimitedMenu ? 'bg-purple-50 border-purple-500' : 'bg-gray-50 border-gray-200'}`}>
            <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2">
                    <div className={`p-2 rounded-full ${localSettings.showLimitedMenu ? 'bg-purple-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                        <Zap size={20} />
                    </div>
                    <div>
                        <h3 className="font-bold text-gray-800">{t.decoMode}</h3>
                        <p className="text-xs text-gray-500">{t.decoModeDesc}</p>
                    </div>
                </div>
                <button
                    onClick={toggleSpecialMenu}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${localSettings.showLimitedMenu ? 'bg-purple-600' : 'bg-gray-300'}`}
                >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${localSettings.showLimitedMenu ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
            </div>

            {localSettings.showLimitedMenu && (
                <p className="text-xs text-purple-700 bg-purple-100 p-2 rounded mt-2">
                   {t.decoMode} - {t.active}
                </p>
            )}

            {isDisabling && (
                <div className="mt-3 bg-red-50 p-3 rounded-lg border border-red-200 animate-in fade-in slide-in-from-top-2">
                    <p className="text-red-700 text-xs font-bold flex items-start gap-2">
                        <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                        <span>Warning: Disabling will delete special items.</span>
                    </p>
                </div>
            )}
          </div>

          <div>
            <h3 className="font-bold text-gray-700 mb-3 border-b pb-2">{t.deliveryCosts}</h3>
            <div className="space-y-3">
                <div>
                    <label className="block text-sm text-gray-600 mb-1">{t.dailyMotorCost} ({t.currency})</label>
                    <input
                        type="number"
                        step="0.01"
                        value={localSettings.dailyMotorcycleCost}
                        onChange={(e) => setLocalSettings({ ...localSettings, dailyMotorcycleCost: parseFloat(e.target.value) || 0 })}
                        className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white"
                    />
                </div>
                <div>
                    <label className="block text-sm text-gray-600 mb-1">{t.perDeliveryCost} ({t.currency})</label>
                    <input
                        type="number"
                        step="0.01"
                        value={localSettings.perDeliveryCost}
                        onChange={(e) => setLocalSettings({ ...localSettings, perDeliveryCost: parseFloat(e.target.value) || 0 })}
                        className="w-full p-2 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none bg-white"
                    />
                </div>
            </div>
            <button
                onClick={handleSave}
                className="mt-4 w-full bg-blue-600 text-white py-2 rounded-lg font-bold hover:bg-blue-700 flex items-center justify-center gap-2"
            >
                <Save size={18} /> {t.save}
            </button>
          </div>

          <div className="pt-4 border-t">
            <h3 className="font-bold text-gray-700 mb-3 flex items-center gap-2">
                📦 {t.backup}
            </h3>
            <div className="space-y-3">
              <button onClick={onExport} className="w-full bg-emerald-600 text-white px-4 py-3 rounded-xl flex items-center justify-center gap-2 font-bold hover:bg-emerald-700 transition-colors">
                <Download size={20} />
                {t.exportData}
              </button>

              <label className="w-full bg-indigo-600 text-white px-4 py-3 rounded-xl flex items-center justify-center gap-2 font-bold hover:bg-indigo-700 cursor-pointer transition-colors">
                <Upload size={20} />
                {t.importData}
                <input type="file" accept=".json,application/json" onChange={onImport} className="hidden" />
              </label>
            </div>

            <div className="mt-4 bg-yellow-50 border-r-4 border-yellow-400 p-3 rounded-lg flex gap-3">
              <AlertTriangle className="text-yellow-500 shrink-0" size={24} />
              <div>
                <p className="text-xs text-gray-600 mt-1">
                  {t.warningImport}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;