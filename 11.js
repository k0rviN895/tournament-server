using UnityEngine;
using UnityEngine.UI;
using UnityEngine.SceneManagement;
using System.Collections;
using TMPro;
using System.Diagnostics;

public class GameManager : MonoBehaviour
{
    public static GameManager Instance { get; private set; }

    [Header("References")]
    public PlayerController player;
    public ReviveSystem reviveSystem;
    public GameObject pausePanel;

    public TextMeshProUGUI scoreText;
    public Text speedText;
    public Text livesText;
    public Text timerText;
 
    public GameObject gameOverPanel;
    public TextMeshProUGUI finalScoreText;
    public GameObject mainHUD;

    // Используем конкретные типы для фейдов
    public DarkenOverlayController darkenOverlay;
    public UIFader transitionFader;

    [Header("Game Settings - Lives")]
    [Tooltip("Базовое количество жизней без баффов")]
    public int defaultMaxLives = 3;

    [Tooltip("Абсолютный лимит жизней (база + все возможные баффы)")]
    public int absoluteMaxLivesCap = 5;

    [Header("Difficulty")]
    public float startSpeed = 5f;
    public float maxSpeed = 20f;
    public float baseSpeedIncreaseRate = 0.1f;
    public float scoreSpeedFactor = 0.0005f;

    [Header("Tournament Mode")]
    public bool tournamentMode = false;
    public float tournamentTime = 180f;

    [Header("Levels")]
    public string nextLevelName;

    private float currentSpeed;
    private float score;
    private float timer;
    private bool isGameOver = false;

    public float checkpointScore = 0f;
    
    // === ГЛОБАЛЬНЫЙ ПАРАМЕТР СЕССИИ ===
    // Не сбрасывается при смене сцен или выходе в меню.
    // Сбрасывается только при полном закрытии игры (если не сохранять в PlayerPrefs)
    private int sessionMaxLivesBonus = 0; 

    // Свойство для доступа извне (для достижений)
    public int CurrentMaxLives => defaultMaxLives + sessionMaxLivesBonus;

    public float GetCurrentSpeed() => currentSpeed;
    public float GetCurrentScore() => score;

    private void Awake()
    {
        if (Instance == null) 
        {
            Instance = this;
            DontDestroyOnLoad(gameObject);

             SceneManager.sceneLoaded += OnSceneLoaded;
        }
        else
        {
            Destroy(gameObject); // Уничтожить дубликат, если он уже есть
            return;
        }
    }
        // Добавьте этот метод в класс GameManager
        // Вызывайте этот метод в Start() после FindPlayer()
        private void FindUIReferencesInCurrentScene()
    {
        UnityEngine.Debug.Log("GameManager: Поиск UI элементов в текущей сцене...");

        // 1. Ищем ReviveSystem по компоненту (самый надежный способ)
        if (reviveSystem == null)
            reviveSystem = FindObjectOfType<ReviveSystem>();

        // 2. Ищем текстовые элементы по компоненту TextMeshProUGUI или Text
        // Если у вас несколько TMP_Text, нужно искать по имени GameObject'а, к которому прикреплен компонент
        
        // Ищем ScoreText (TMP)
        var scoreTextObj = GameObject.Find("ScoreText");
        if (scoreTextObj != null)
            scoreText = scoreTextObj.GetComponent<TextMeshProUGUI>();

        // Ищем SpeedText (обычный Text)
        var speedTextObj = GameObject.Find("SpeedText");
        if (speedTextObj != null)
            speedText = speedTextObj.GetComponent<Text>();

        // Ищем LivesText (обычный Text)
        var livesTextObj = GameObject.Find("LivesText");
        if (livesTextObj != null)
            livesText = livesTextObj.GetComponent<Text>();

        // Ищем TimerText (обычный Text)
        var timerTextObj = GameObject.Find("TimerText");
        if (timerTextObj != null)
            timerText = timerTextObj.GetComponent<Text>();

        // 3. Ищем панели по имени GameObject
        GameObject gameOverPanelObj = GameObject.Find("GameOverPanel");
        if (gameOverPanelObj != null)
            gameOverPanel = gameOverPanelObj;

        // Ищем FinalScoreText (TMP)
        if (finalScoreText == null)
        {
            var finalScoreTextObj = GameObject.Find("FinalScoreText");
            if (finalScoreTextObj != null)
                finalScoreText = finalScoreTextObj.GetComponent<TextMeshProUGUI>();
        }

        // Ищем MainHUD
        GameObject mainHUDObj = GameObject.Find("MainHUD");
        if (mainHUDObj != null)
            mainHUD = mainHUDObj;

        GameObject pausePanelObj = GameObject.Find("PausePanel");
        if (pausePanelObj != null)
            pausePanel = pausePanelObj; 

        // 4. Ищем системы затемнения и фейда по компоненту
        if (darkenOverlay == null)
        {
            var darkenObj = GameObject.Find("DarkenOverlay");
            if (darkenObj != null)
                darkenOverlay = darkenObj.GetComponent<DarkenOverlayController>();
        }

        if (transitionFader == null)
        {
            var faderObj = GameObject.Find("TransitionFader");
            if (faderObj != null)
                transitionFader = faderObj.GetComponent<UIFader>();
        }

        // Логирование результатов
        UnityEngine.Debug.Log($"ReviveSystem: {(reviveSystem != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"ScoreText: {(scoreText != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"SpeedText: {(speedText != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"LivesText: {(livesText != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"TimerText: {(timerText != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"GameOverPanel: {(gameOverPanel != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"FinalScoreText: {(finalScoreText != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"MainHUD: {(mainHUD != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"DarkenOverlay: {(darkenOverlay != null ? "Найден" : "НЕ НАЙДЕН")}");
        UnityEngine.Debug.Log($"TransitionFader: {(transitionFader != null ? "Найден" : "НЕ НАЙДЕН")}");
    }

    private void OnEnable()
    {
        // Если вы хотите, чтобы бафф сохранялся даже после закрытия игры полностью,
        // раскомментируйте строку ниже:
        // sessionMaxLivesBonus = PlayerPrefs.GetInt("SessionMaxLivesBonus", 0);
    }

    private void OnDestroy()
    {
        // Отписываемся, чтобы избежать ошибок при удалении объекта
        SceneManager.sceneLoaded -= OnSceneLoaded;
    }

    // Этот метод вызывается АВТОМАТИЧЕСКИ каждый раз при загрузке новой сцены
    private void OnSceneLoaded(Scene scene, LoadSceneMode mode)
    {
        UnityEngine.Debug.Log($"GameManager: Сцена загружена ({scene.name}). Обновляем ссылки...");
        
        // Запускаем корутину, чтобы дать объектам сцены 1 кадр на инициализацию
        StartCoroutine(RefreshReferencesAfterLoad());
    }

    private IEnumerator RefreshReferencesAfterLoad()
    {
        yield return null; // Ждем конец кадра

        // 1. Ищем все ссылки заново в новой сцене
        FindPlayer();
        FindUIReferencesInCurrentScene();

        UpdateLevelSettingsFromScene();
        SetupMenuButtons();

        // 2. Сбрасываем состояние игры
        isGameOver = false;
        Time.timeScale = 1f;

        // 3. Настраиваем UI
        if (mainHUD != null) mainHUD.SetActive(true);
        if (gameOverPanel != null) gameOverPanel.SetActive(false);
        if (timerText != null) timerText.gameObject.SetActive(tournamentMode);

        // 4. Загружаем прогресс (счет, скорость)
        LoadProgress();
        LoadSpeed();

        // 5. Инициализируем жизни (с учетом глобального бонуса)
        InitializePlayerLives();
        UpdateLivesUI();
    }

    private void InitializePlayerLives()
    {
        if (player == null) return;

        // Логика: При старте уровня жизни всегда равны текущему глобальному максимуму
        int currentGlobalMax = defaultMaxLives + sessionMaxLivesBonus;
        
        // Ограничиваем абсолютным капом
        if (currentGlobalMax > absoluteMaxLivesCap) 
            currentGlobalMax = absoluteMaxLivesCap;

        // Устанавливаем и жизни, и макс. жизни равными этому значению
        player.SetLives(currentGlobalMax, currentGlobalMax);
        
        UnityEngine.Debug.Log($"GameManager: Инициализация жизней. Max: {currentGlobalMax}, Lives: {currentGlobalMax}");
    }

    private void UpdateLevelSettingsFromScene()
    {       
        string currentScene = SceneManager.GetActiveScene().name;
        
        if (currentScene == "soft_world")
        {
            nextLevelName = "hard_world"; // Или другая сцена
        }
        else if (currentScene == "hard_world")
        {
            nextLevelName = "soft_world"; // Или другая сцена
        }
        
        UnityEngine.Debug.Log($"GameManager: Текущая сцена: {currentScene}. Следующая сцена установлена в: {nextLevelName}");
    }

    private void FindPlayer()
    {
        if (player == null) player = FindObjectOfType<PlayerController>();
        if (player != null)
        {
            player.OnLivesChanged -= UpdateLivesUI;
            player.OnLivesChanged += UpdateLivesUI;
        }
    }

    private void LoadProgress()
    {
        // Загружаем только счет, так как жизни управляются логикой выше
        int savedScore = PlayerPrefs.GetInt("SavedScore", 0);
        score = savedScore;

        if (scoreText != null) scoreText.text = Mathf.FloorToInt(score).ToString();
    }

    private void SaveProgress()
    {
        if (player == null) FindPlayer();
        PlayerPrefs.SetInt("SavedScore", Mathf.FloorToInt(score));
        PlayerPrefs.Save();
    }

    private void SaveSpeed()
    {
        PlayerPrefs.SetFloat("SavedSpeed", currentSpeed);
        PlayerPrefs.Save();
    }

    private void LoadSpeed()
    {
        if (PlayerPrefs.HasKey("SavedSpeed"))
        {
            currentSpeed = PlayerPrefs.GetFloat("SavedSpeed");
            currentSpeed = Mathf.Min(currentSpeed, maxSpeed);
        }
        else
        {
            currentSpeed = startSpeed;
        }
    }

    private void Update()
    {
        if (isGameOver) return;

        float dynamicIncrease = baseSpeedIncreaseRate * (1f + score * scoreSpeedFactor);
        if (currentSpeed < maxSpeed)
        {
            currentSpeed += dynamicIncrease * Time.deltaTime;
            currentSpeed = Mathf.Min(currentSpeed, maxSpeed);
        }

        score += currentSpeed * Time.deltaTime;

        if (scoreText != null) scoreText.text = Mathf.FloorToInt(score).ToString();
        if (speedText != null) speedText.text = currentSpeed.ToString("F1");

        if (tournamentMode)
        {
            timer -= Time.deltaTime;
            if (timerText != null)
            {
                int minutes = Mathf.FloorToInt(timer / 60);
                int seconds = Mathf.FloorToInt(timer % 60);
                timerText.text = string.Format("{0:00}:{1:00}", minutes, seconds);
            }
            if (timer <= 0f) GameOver(true);
        }
    }

    private void UpdateLivesUI(int currentLives, int maxLives)
    {
        if (livesText != null) livesText.text = currentLives + "/" + maxLives;
    }

    private void UpdateLivesUI()
    {
        if (player == null) return;
        if (livesText != null) livesText.text = player.lives + "/" + player.maxLives;
    }

    public void GameOver(bool tournamentEnd = false)
    {
        if (isGameOver) return;
        
        UnityEngine.Debug.Log("GameManager: GameOver вызван.");
        
        isGameOver = true;
        checkpointScore = score;

        if (reviveSystem == null)
        {
            UnityEngine.Debug.LogError("GameManager: ReviveSystem НЕ НАЙДЕН!");
            ShowDeadMenu();
            return;
        }

        if (reviveSystem.CanRevive())
        {
            reviveSystem.ShowReviveOption();
        }
        else
        {
            ShowDeadMenu();
        }
    }

    public void ShowDeadMenu()
    {
        Time.timeScale = 0f;
        if (darkenOverlay != null) darkenOverlay.FadeToDark();
        if (mainHUD != null) mainHUD.SetActive(false);
        if (gameOverPanel != null)
        {
            gameOverPanel.SetActive(true);
            if (finalScoreText != null) finalScoreText.text = Mathf.FloorToInt(score).ToString();
        }
    }

    // === ЛОГИКА БАФФА И ВОЗРОЖДЕНИЯ ===
    public void ApplyPermanentLifeBuffAndRevive()
    {
        // 1. Увеличиваем глобальный бонус сессии на 1
        sessionMaxLivesBonus++;
        
        // Опционально: Сохраняем этот бонус, чтобы он жил даже после закрытия игры
        // PlayerPrefs.SetInt("SessionMaxLivesBonus", sessionMaxLivesBonus);
        // PlayerPrefs.Save();

        UnityEngine.Debug.Log($"GameManager: Бафф активирован! Текущий бонус: {sessionMaxLivesBonus}");

        // 2. Возрождаем игрока
        RevivePlayerInternal();
    }

    private void RevivePlayerInternal()
    {
        isGameOver = false;
        checkpointScore = score;
        Time.timeScale = 1f;

        if (gameOverPanel != null) gameOverPanel.SetActive(false);
        if (mainHUD != null) mainHUD.SetActive(true);

        if (player != null)
        {
            // Рассчитываем новый максимум: База + Глобальный Бонус
            int newMax = defaultMaxLives + sessionMaxLivesBonus;
            if (newMax > absoluteMaxLivesCap) newMax = absoluteMaxLivesCap;

            // Устанавливаем жизни равными максимуму (полное восстановление)
            player.SetLives(newMax, newMax);
            
            UnityEngine.Debug.Log($"GameManager: Возрождение. MaxLives: {newMax}, Lives: {newMax}");
        }
    }

    public void RestartGame()
    {
        // Полный сброс сессии: очищаем сохранения счета/скорости
        PlayerPrefs.DeleteKey("SavedScore");
        PlayerPrefs.DeleteKey("SavedSpeed");
        PlayerPrefs.Save();
        
        // ВАЖНО: Мы НЕ сбрасываем sessionMaxLivesBonus здесь, так как это глобальный параметр сессии.
        // Если вы хотите сбрасывать его только при полном выходе из игры, ничего делать не надо.
        // Если хотите сбрасывать при нажатии "Restart" в меню, раскомментируйте строку ниже:
        // sessionMaxLivesBonus = 0;

        Time.timeScale = 1f;
        SceneManager.LoadScene(SceneManager.GetActiveScene().name); 
    }

    public void LoadMainMenu()
    {
        Time.timeScale = 1f;
        // Мы НЕ сбрасываем sessionMaxLivesBonus здесь, чтобы он сохранялся между запусками уровней
        SceneManager.LoadScene("main_menu");
    }

    public void StartTransitionFade()
    {
        if (transitionFader != null)
            transitionFader.FadeToBlack();
    }

    public void GoToNextLocation()
    {
        SaveSpeed();
        SaveProgress();
        StartCoroutine(TransitionToNextLevel());
    }

        private IEnumerator TransitionToNextLevel()
    {
        // Запускаем фейд затемнения
        if (transitionFader != null)
            transitionFader.FadeToBlack();

        // Ждем время длительности фейда
        float waitTime = transitionFader != null ? transitionFader.fadeDuration : 0.5f;
        yield return new WaitForSecondsRealtime(waitTime);

        Time.timeScale = 1f;

        // === ЛОГИКА ПЕРЕХОДА БЕЗ РАНДОМИЗАЦИИ ===
        
        string nextSceneName = "";

        // Если в инспекторе GameManager указано имя следующей сцены, используем его
        if (!string.IsNullOrEmpty(nextLevelName))
        {
            nextSceneName = nextLevelName;
        }
        else
        {
            // Если поле пустое, пытаемся загрузить следующую сцену по индексу в Build Settings
            // Это полезно, если у вас линейный порядок уровней
            int currentIndex = SceneManager.GetActiveScene().buildIndex;
            int nextIndex = currentIndex + 1;
            
            if (nextIndex < SceneManager.sceneCountInBuildSettings)
            {
                nextSceneName = SceneManager.GetSceneByBuildIndex(nextIndex).name;
            }
            else
            {
                UnityEngine.Debug.LogWarning("GameManager: Нет следующей сцены в Build Settings. Перезагружаем текущую.");
                nextSceneName = SceneManager.GetActiveScene().name;
            }
        }

        UnityEngine.Debug.Log("GameManager: Переход в сцену: " + nextSceneName);

        // Проверяем существование сцены перед загрузкой
        bool sceneExists = false;
        for (int i = 0; i < SceneManager.sceneCountInBuildSettings; i++)
        {
            string path = SceneUtility.GetScenePathByBuildIndex(i);
            if (path.Contains(nextSceneName))
            {
                sceneExists = true;
                break;
            }
        }

        if (sceneExists)
        {
            SceneManager.LoadScene(nextSceneName);
        }
        else
        {
            UnityEngine.Debug.LogError($"GameManager: Сцена '{nextSceneName}' не найдена в Build Settings!");
            // В случае ошибки загружаем текущую сцену заново, чтобы игра не зависла
            SceneManager.LoadScene(SceneManager.GetActiveScene().name);
        }
    }
    private void SetupMenuButtons()
    {
        UnityEngine.Debug.Log("GameManager: Настройка кнопок меню...");

        // Находим ВСЕ кнопки на сцене
        UnityEngine.UI.Button[] allButtons = FindObjectsOfType<UnityEngine.UI.Button>();

        foreach (UnityEngine.UI.Button btn in allButtons)
        {
            string btnName = btn.name;

            // --- КНОПКИ ПАНЕЛИ СМЕРТИ ---
            if (btnName == "BtnRestart")
            {
                btn.onClick.RemoveAllListeners();
                btn.onClick.AddListener(RestartGame);
                UnityEngine.Debug.Log($"Настроена кнопка Restart: {btn.name}");
            }
            else if (btnName == "BtnMainMenu")
            {
                btn.onClick.RemoveAllListeners();
                btn.onClick.AddListener(LoadMainMenu);
                UnityEngine.Debug.Log($"Настроена кнопка Main Menu: {btn.name}");
            }
            
            // --- КНОПКИ ПАНЕЛИ ПАУЗЫ ---
            else if (btnName == "BtnResume")
            {
                btn.onClick.RemoveAllListeners();
                btn.onClick.AddListener(() => {
                    Time.timeScale = 1f;
                    GameObject pp = GameObject.Find("PausePanel");
                    if (pp != null) pp.SetActive(false);
                    GameObject pb = GameObject.Find("PauseButton");
                    if (pb != null) pb.SetActive(true);
                });
                UnityEngine.Debug.Log($"Настроена кнопка Resume: {btn.name}");
            }
            else if (btnName == "BtnPauseRestart")
            {
                btn.onClick.RemoveAllListeners();
                btn.onClick.AddListener(RestartGame);
                UnityEngine.Debug.Log($"Настроена кнопка Pause Restart: {btn.name}");
            }
            else if (btnName == "BtnPauseMainMenu")
            {
                btn.onClick.RemoveAllListeners();
                btn.onClick.AddListener(LoadMainMenu);
                UnityEngine.Debug.Log($"Настроена кнопка Pause Main Menu: {btn.name}");
            }
        }
    }

    private bool SceneExists(string sceneName)
    {
        for (int i = 0; i < SceneManager.sceneCountInBuildSettings; i++)
        {
            string path = SceneUtility.GetScenePathByBuildIndex(i);
            if (path.Contains(sceneName))
                return true;
        }
        return false;
    }
}