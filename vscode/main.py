"""BlueCome CMG Backend — 基于 AI 模型的 Git Commit Message 生成服务"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Optional
import os
import re

# ── 配置 ──────────────────────────────────────────────
# 从环境变量读取，也可以在下面直接填写（不推荐）
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com"

# 如果 DEEPSEEK_API_KEY 为空，会启用本地降级模式
# ──────────────────────────────────────────────────────

app = FastAPI(title="BlueCome CMG Backend")


class CommitBody(BaseModel):
    diff: str
    historyMessage: Optional[list[str]] = None
    needRec: int = 0
    temperature: float = 0.9
    max_tokens: int = 30
    language: str = "auto"
    userInput: Optional[str] = None


def clean_diff(raw: str) -> str:
    """过滤掉二进制文件、pycache 等无意义变更，缩小 token 消耗"""
    lines = raw.splitlines()
    filtered = []
    skip = False
    for line in lines:
        # 跳过二进制文件
        if line.startswith("Binary files") or line.startswith("GIT binary patch"):
            skip = True
            continue
        # 跳过 __pycache__ / node_modules / .gitignore 等
        if re.search(r'(__pycache__|node_modules|\.pyc|\.gitignore)', line):
            continue
        if skip and not line.startswith("diff --git"):
            continue
        skip = False
        filtered.append(line)

    result = "\n".join(filtered)
    # 如果清理后太长，截取前后关键部分（控制 token 消耗）
    if len(result) > 8000:
        result = result[:4000] + "\n... (中间省略) ...\n" + result[-4000:]
    return result


def _resolve_language(language: str) -> str:
    if language == "auto":
        try:
            import locale
            lang_code = locale.getdefaultlocale()[0] or ""
        except Exception:
            lang_code = os.environ.get("LANG", "") or os.environ.get("LC_ALL", "")
        if lang_code.lower().startswith("zh"):
            return "zh"
        if lang_code.lower().startswith("ja"):
            return "ja"
        if lang_code.lower().startswith("fr"):
            return "fr"
        if lang_code.lower().startswith("de"):
            return "de"
        if lang_code.lower().startswith("ru"):
            return "ru"
        return "en"
    if language in ("zh", "en", "ja", "ru", "fr", "de"):
        return language
    return "en"


def _build_completion_prompt(
    user_input: str,
    diff: str,
    history: Optional[list[str]],
    lang: str,
) -> tuple[str, str]:
    """用户已输入部分 commit message，让 AI 补全或改进"""
    prompts = {
        "zh": (
            "你是一个专业的 Git Commit Message 助手。用户已写了部分提交信息，请根据 git diff 补全或改进它，保持 Conventional Commits 规范，用中文描述，只输出最终的提交信息，不要解释。",
            f"用户已输入：{user_input}\n\n代码变更如下：\n```diff\n{diff}\n```",
        ),
        "ja": (
            "あなたはプロの Git Commit Message アシスタントです。ユーザーが入力した部分的なコミットメッセージを、git diff に基づいて補完・改善してください。Conventional Commits 規約に従い日本語で記述し、最終的なコミットメッセージのみを出力してください。",
            f"ユーザー入力：{user_input}\n\nコード変更：\n```diff\n{diff}\n```",
        ),
        "ru": (
            "Вы — профессиональный помощник по Git Commit Message. Пользователь ввёл частичное сообщение коммита — дополните или улучшите его на основе git diff. Следуйте стандарту Conventional Commits, описывайте на русском языке, выводите только итоговое сообщение.",
            f"Ввод пользователя: {user_input}\n\nИзменения кода:\n```diff\n{diff}\n```",
        ),
        "fr": (
            "Vous êtes un assistant professionnel pour les messages de commit Git. L'utilisateur a saisi un message partiel — complétez ou améliorez-le en vous basant sur le git diff. Suivez la norme Conventional Commits, rédigez en français, et ne retournez que le message final.",
            f"Saisie utilisateur : {user_input}\n\nModifications :\n```diff\n{diff}\n```",
        ),
        "de": (
            "Sie sind ein professioneller Git-Commit-Message-Assistent. Der Benutzer hat eine teilweise Commit-Nachricht eingegeben — vervollständigen oder verbessern Sie diese anhand des git diff. Halten Sie den Conventional-Commits-Standard ein, beschreiben Sie auf Deutsch, und geben Sie nur die endgültige Nachricht aus.",
            f"Benutzereingabe: {user_input}\n\nCode-Änderungen:\n```diff\n{diff}\n```",
        ),
    }
    system_prompt, user_prompt = prompts.get(lang, (
        "You are a professional Git Commit Message assistant. The user has typed a partial commit message — complete or improve it based on the git diff. Follow Conventional Commits, write in English, output only the final message.",
        f"User input: {user_input}\n\nCode changes:\n```diff\n{diff}\n```",
    ))
    if history:
        sep = {"zh": "\n\n参考近期提交风格：\n", "ja": "\n\n最近のコミットスタイル参考：\n",
               "ru": "\n\nСтиль недавних коммитов:\n", "fr": "\n\nStyle des commits récents :\n",
               "de": "\n\nStil der letzten Commits:\n"}.get(lang, "\n\nRecent commit style reference:\n")
        user_prompt += sep + "\n".join(f"- {h}" for h in history)
    return system_prompt, user_prompt


def build_prompt(diff: str, history: Optional[list[str]], language: str = "auto", user_input: Optional[str] = None) -> tuple[str, str]:
    lang = _resolve_language(language)

    if user_input and user_input.strip():
        return _build_completion_prompt(user_input.strip(), diff, history, lang)

    if lang == "zh":
        system_prompt = """你是一个专业的 Git Commit Message 生成助手。
根据提供的 git diff 内容，生成符合 Conventional Commits 规范的提交信息。

规范说明：
- feat:     新功能
- fix:      Bug 修复
- docs:     文档更新
- style:    代码格式（不影响功能）
- refactor: 代码重构
- perf:     性能优化
- test:     测试相关
- chore:    构建/工具链变更
- revert:   回退操作

要求：
1. 第一行是标题（50字以内），空一行后跟详细描述
2. 使用中文描述
3. 说明做了什么、为什么做
4. 不要出现"更新"、"优化"这类模糊词汇，要具体"""

        user_prompt = f"请根据以下代码变更生成 Git commit message：\n\n```diff\n{diff}\n```"

        if history:
            user_prompt += f"\n\n参考该仓库近期的提交风格：\n" + "\n".join(f"- {h}" for h in history)

    elif lang == "ja":
        system_prompt = """あなたはプロの Git Commit Message 生成アシスタントです。
提供された git diff 内容に基づいて、Conventional Commits 規約に準拠したコミットメッセージを生成してください。

規約：
- feat:     新機能
- fix:      バグ修正
- docs:     ドキュメント更新
- style:    コードフォーマット（機能に影響しない）
- refactor: コードリファクタリング
- perf:     パフォーマンス最適化
- test:     テスト関連
- chore:    ビルド/ツールチェーン変更
- revert:   ロールバック操作

要件：
1. 最初の行はタイトル（50文字以内）、空行の後に詳細説明
2. 日本語で記述
3. 何をしたか、なぜしたかを説明
4. 「更新」、「最適化」のような曖昧な言葉は避け、具体的に記述"""

        user_prompt = f"以下のコード差分に対する Git commit message を生成してください：\n\n```diff\n{diff}\n```"

        if history:
            user_prompt += f"\n\nこのリポジトリの最近のコミットスタイルを参考：\n" + "\n".join(f"- {h}" for h in history)

    elif lang == "ru":
        system_prompt = """Вы — профессиональный помощник по генерации Git Commit Message.
На основе предоставленного содержимого git diff создайте сообщение коммита, соответствующее стандарту Conventional Commits.

Стандарты:
- feat:     Новая функциональность
- fix:      Исправление ошибок
- docs:     Обновление документации
- style:    Форматирование кода (не влияет на функциональность)
- refactor: Рефакторинг кода
- perf:     Оптимизация производительности
- test:     Связано с тестами
- chore:    Изменения сборки/инструментов
- revert:   Откат операции

Требования:
1. Первая строка — заголовок (не более 50 символов), после пустой строки — подробное описание
2. Описывайте на русском языке
3. Объясните, что было сделано и почему
4. Избегайте неопределённых слов, таких как «обновление», «оптимизация», будьте конкретны"""

        user_prompt = f"Пожалуйста, создайте Git commit message для следующего diff:\n\n```diff\n{diff}\n```"

        if history:
            user_prompt += f"\n\nОбратите внимание на недавний стиль коммитов этого репозитория:\n" + "\n".join(f"- {h}" for h in history)

    elif lang == "fr":
        system_prompt = """Vous êtes un assistant professionnel de génération de message Git Commit.
Sur la base du contenu git diff fourni, générez un message de commit conforme à la norme Conventional Commits.

Normes :
- feat:     Nouvelle fonctionnalité
- fix:      Correction de bug
- docs:     Mise à jour de la documentation
- style:    Formatage du code (sans impact sur la fonctionnalité)
- refactor: Refonte du code
- perf:     Optimisation des performances
- test:     Lié aux tests
- chore:    Changements de build/outils
- revert:   Opération de retour

Exigences :
1. La première ligne est le titre (50 caractères max), suivi d'une ligne vide puis d'une description détaillée
2. Décrivez en français
3. Expliquez ce qui a été fait et pourquoi
4. Évitez les mots vagues comme « mise à jour », « optimisation », soyez spécifique"""

        user_prompt = f"Veuillez générer un message de commit Git pour le diff suivant :\n\n```diff\n{diff}\n```"

        if history:
            user_prompt += f"\n\nRéférence des commits récents de ce dépôt :\n" + "\n".join(f"- {h}" for h in history)

    elif lang == "de":
        system_prompt = """Sie sind ein professioneller Assistent für die Generierung von Git Commit Messages.
Basierend auf dem bereitgestellten git diff-Inhalt erstellen Sie eine Commit-Message, die dem Conventional Commits-Standard entspricht.

Standards:
- feat:     Neue Funktion
- fix:      Fehlerbehebung
- docs:     Dokumentationsaktualisierung
- style:    Code-Formatierung (keine Auswirkung auf die Funktionalität)
- refactor: Code-Refactoring
- perf:     Leistungsoptimierung
- test:     Testbezogen
- chore:    Build-/Toolchain-Änderungen
- revert:   Rückgängigmachung

Anforderungen:
1. Erste Zeile ist der Titel (max. 50 Zeichen), nach einer Leerzeile folgt eine detaillierte Beschreibung
2. Beschreiben Sie auf Deutsch
3. Erklären Sie, was getan wurde und warum
4. Vermeiden Sie vage Wörter wie „Aktualisierung“, „Optimierung“, seien Sie spezifisch"""

        user_prompt = f"Bitte generieren Sie eine Git-Commit-Nachricht für den folgenden Diff:\n\n```diff\n{diff}\n```"

        if history:
            user_prompt += f"\n\nReferenz der letzten Commits in diesem Repository:\n" + "\n".join(f"- {h}" for h in history)

    else:
        system_prompt = """You are a professional Git Commit Message generation assistant.
Based on the provided git diff content, generate a commit message that conforms to the Conventional Commits standard.

Standards:
- feat:     New feature
- fix:      Bug fix
- docs:     Documentation update
- style:    Code formatting (no impact on functionality)
- refactor: Code refactoring
- perf:     Performance optimization
- test:     Test-related
- chore:    Build/toolchain changes
- revert:   Revert operation

Requirements:
1. First line is the title (within 50 characters), followed by a blank line and detailed description
2. Describe in English
3. Explain what was done and why
4. Avoid vague words like "update", "optimize", be specific"""

        user_prompt = f"Please generate a Git commit message for the following code diff:\n\n```diff\n{diff}\n```"

        if history:
            user_prompt += f"\n\nReference the recent commit style of this repository:\n" + "\n".join(f"- {h}" for h in history)

    return system_prompt, user_prompt


def call_deepseek(
    system_prompt: str,
    user_prompt: str,
    temperature: float,
    max_tokens: int,
    need_rec: bool,
) -> list[str]:
    """调用 DeepSeek API 生成 commit message"""
    from openai import OpenAI

    client = OpenAI(api_key=DEEPSEEK_API_KEY, base_url=DEEPSEEK_BASE_URL)

    n_choices = 5 if need_rec else 1

    resp = client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
        n=n_choices,
    )

    messages = []
    for choice in resp.choices:
        text = choice.message.content.strip()
        # 取第一行作为标题（有些模型会输出多行）
        first_line = text.split("\n")[0].strip()
        if first_line:
            messages.append(first_line)

    return messages if messages else ["feat: no commit message generated"]


def local_fallback(diff: str, need_rec: bool, language: str = "auto") -> list[str]:
    """离线降级：简单根据 diff 关键词生成占位消息"""
    diff_lower = diff.lower()
    lang = _resolve_language(language)

    if lang == "zh":
        if "feat" in diff_lower or "add" in diff_lower or "new" in diff_lower:
            base = "feat: 新增功能并优化代码结构"
        elif "fix" in diff_lower or "bug" in diff_lower or "issue" in diff_lower:
            base = "fix: 修复代码问题并提升稳定性"
        elif "refactor" in diff_lower or "clean" in diff_lower:
            base = "refactor: 清理代码并简化逻辑"
        elif "doc" in diff_lower or "readme" in diff_lower or "comment" in diff_lower:
            base = "docs: 更新文档并添加注释"
        else:
            base = "chore: 更新代码和配置"

        if need_rec:
            return [
                base,
                "fix: 修复模块中潜在问题",
                "refactor: 优化代码结构和可读性",
                "style: 格式化代码并修复 lint 问题",
                "chore: 更新依赖和配置",
            ]
        return [base]

    _fallback_map = {
        "ja": {
            "feat": "feat: 新機能を追加しコード構造を改善",
            "fix": "fix: コードの問題を修正し安定性を向上",
            "refactor": "refactor: コードをクリーンアップしロジックを簡略化",
            "docs": "docs: ドキュメントを更新しコメントを追加",
            "chore": "chore: コードと設定を更新",
            "rec": ["fix: モジュールの潜在的な問題を修正", "refactor: コード構造と可読性を最適化",
                    "style: コードをフォーマットし lint 問題を修正", "chore: 依存関係と設定を更新"],
        },
        "ru": {
            "feat": "feat: добавить новую функциональность и улучшить структуру",
            "fix": "fix: исправить проблему и повысить стабильность",
            "refactor": "refactor: очистить код и упростить логику",
            "docs": "docs: обновить документацию и добавить комментарии",
            "chore": "chore: обновить код и конфигурацию",
            "rec": ["fix: устранить потенциальные проблемы в модуле", "refactor: оптимизировать структуру кода",
                    "style: форматировать код и исправить линтер", "chore: обновить зависимости и конфигурацию"],
        },
        "fr": {
            "feat": "feat: ajouter une nouvelle fonctionnalité et améliorer la structure",
            "fix": "fix: résoudre un problème et améliorer la stabilité",
            "refactor": "refactor: nettoyer le code et simplifier la logique",
            "docs": "docs: mettre à jour la documentation et ajouter des commentaires",
            "chore": "chore: mettre à jour le code et la configuration",
            "rec": ["fix: résoudre les problèmes potentiels du module", "refactor: optimiser la structure du code",
                    "style: formater le code et corriger le linter", "chore: mettre à jour les dépendances"],
        },
        "de": {
            "feat": "feat: neue Funktion hinzufügen und Struktur verbessern",
            "fix": "fix: Problem beheben und Stabilität erhöhen",
            "refactor": "refactor: Code bereinigen und Logik vereinfachen",
            "docs": "docs: Dokumentation aktualisieren und Kommentare hinzufügen",
            "chore": "chore: Code und Konfiguration aktualisieren",
            "rec": ["fix: potenzielle Probleme im Modul beheben", "refactor: Codestruktur optimieren",
                    "style: Code formatieren und Linting-Probleme beheben", "chore: Abhängigkeiten aktualisieren"],
        },
    }

    if lang in _fallback_map:
        m = _fallback_map[lang]
        if "feat" in diff_lower or "add" in diff_lower or "new" in diff_lower:
            base = m["feat"]
        elif "fix" in diff_lower or "bug" in diff_lower or "issue" in diff_lower:
            base = m["fix"]
        elif "refactor" in diff_lower or "clean" in diff_lower:
            base = m["refactor"]
        elif "doc" in diff_lower or "readme" in diff_lower or "comment" in diff_lower:
            base = m["docs"]
        else:
            base = m["chore"]
        if need_rec:
            return [base] + m["rec"]
        return [base]

    # English default
    if "feat" in diff_lower or "add" in diff_lower or "new" in diff_lower:
        base = "feat: add new feature and improve code structure"
    elif "fix" in diff_lower or "bug" in diff_lower or "issue" in diff_lower:
        base = "fix: resolve issue in code and improve stability"
    elif "refactor" in diff_lower or "clean" in diff_lower:
        base = "refactor: clean up code and simplify logic"
    elif "doc" in diff_lower or "readme" in diff_lower or "comment" in diff_lower:
        base = "docs: update documentation and add comments"
    else:
        base = "chore: update code and configuration"

    if need_rec:
        return [
            base,
            "fix: resolve potential issues in module",
            "refactor: optimize code structure and readability",
            "style: format code and fix linting issues",
            "chore: update dependencies and configuration",
        ]
    return [base]


# ── API ───────────────────────────────────────────────

@app.post("/cmg")
async def generate_commit_msg(body: CommitBody):
    print(f"\n--- 收到 diff ({len(body.diff)} chars) ---")
    print(body.diff[:200], "…" if len(body.diff) > 200 else "")
    print(f"needRec={body.needRec}, temperature={body.temperature}, max_tokens={body.max_tokens}, language={body.language}")

    # 1. 清理 diff
    diff = clean_diff(body.diff)
    if not diff.strip():
        raise HTTPException(status_code=400, detail="No meaningful changes found in diff")

    # 2. 构造 prompt
    system_prompt, user_prompt = build_prompt(diff, body.historyMessage, body.language, body.userInput)

    # 3. 调用 AI（或降级）
    if DEEPSEEK_API_KEY:
        try:
            messages = call_deepseek(
                system_prompt,
                user_prompt,
                body.temperature,
                body.max_tokens if body.max_tokens > 0 else 100,
                need_rec=body.needRec == 1,
            )
            print(f"✓ DeepSeek 返回: {messages}")
        except Exception as e:
            print(f"✗ DeepSeek 调用失败: {e}，切换到本地降级")
            messages = local_fallback(diff, body.needRec == 1, body.language)
    else:
        print("⚠ DEEPSEEK_API_KEY 未设置，使用本地降级模式")
        messages = local_fallback(diff, body.needRec == 1, body.language)

    return {"commit_message": messages}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)