// Authentication Module
const AuthModule = {
  currentUser: null,

  // Initialize auth state listener
  init() {
    auth.onAuthStateChanged((user) => {
      this.currentUser = user;
      this.updateUI(user);

      if (user) {
        console.log('User signed in:', user.email);
        // Load user settings and games
        this.loadUserSettings(user.uid);
        GameStorage.loadUserGames(user.uid);
      } else {
        console.log('User signed out');
      }
    });
  },

  // Load user settings from Firestore
  async loadUserSettings(userId) {
    try {
      const userDoc = await db.collection('users').doc(userId).get();

      if (userDoc.exists) {
        const settings = userDoc.data().settings || {};

        // Apply theme setting
        if (settings.theme) {
          ThemeManager.setTheme(settings.theme);
        }

        // Apply other settings to AppState if needed
        if (settings.analysisDepth) {
          // Could update ANALYSIS_DEPTH here if made configurable
        }
      } else {
        // Create user document if it doesn't exist
        await this.createUserDocument(userId);
      }
    } catch (error) {
      console.error('Error loading user settings:', error);
    }
  },

  // Create initial user document
  async createUserDocument(userId) {
    try {
      await db.collection('users').doc(userId).set({
        email: this.currentUser.email,
        displayName: this.currentUser.displayName || '',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        settings: {
          theme: 'light',
          defaultEngine: 'lite',
          autoFlipBoard: true,
          analysisDepth: 15
        },
        subscription: {
          tier: 'free',
          expiresAt: null,
          stripeCustomerId: null
        },
        stats: {
          gamesAnalyzed: 0,
          averageAccuracy: { white: 0, black: 0 },
          commonMistakeTypes: { inaccuracy: 0, mistake: 0, blunder: 0 }
        }
      });
      console.log('User document created');
    } catch (error) {
      console.error('Error creating user document:', error);
    }
  },

  // Google Sign-In
  async signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
    } catch (error) {
      console.error('Google sign-in error:', error);
      if (error.code === 'auth/popup-closed-by-user') {
        // User closed the popup, no need to show error
        return;
      }
      showError('Sign-in failed: ' + error.message);
    }
  },

  // Email/Password Sign-In
  async signInWithEmail(email, password) {
    try {
      await auth.signInWithEmailAndPassword(email, password);
      this.closeEmailAuthModal();
    } catch (error) {
      console.error('Email sign-in error:', error);
      this.showAuthError(error);
    }
  },

  // Email/Password Sign-Up
  async signUpWithEmail(email, password) {
    try {
      await auth.createUserWithEmailAndPassword(email, password);
      this.closeEmailAuthModal();
    } catch (error) {
      console.error('Sign-up error:', error);
      this.showAuthError(error);
    }
  },

  // Show auth error in modal
  showAuthError(error) {
    const errorEl = document.getElementById('auth-error');
    if (errorEl) {
      let message = 'An error occurred';
      switch (error.code) {
        case 'auth/invalid-email':
          message = 'Invalid email address';
          break;
        case 'auth/user-disabled':
          message = 'This account has been disabled';
          break;
        case 'auth/user-not-found':
          message = 'No account found with this email';
          break;
        case 'auth/wrong-password':
          message = 'Incorrect password';
          break;
        case 'auth/email-already-in-use':
          message = 'An account already exists with this email';
          break;
        case 'auth/weak-password':
          message = 'Password must be at least 6 characters';
          break;
        default:
          message = error.message;
      }
      errorEl.textContent = message;
      errorEl.style.display = 'block';
    }
  },

  // Sign Out
  async signOut() {
    try {
      await auth.signOut();
    } catch (error) {
      console.error('Sign-out error:', error);
      showError('Sign-out failed: ' + error.message);
    }
  },

  // Update UI based on auth state
  updateUI(user) {
    const authContainer = document.getElementById('auth-container');
    const userInfo = document.getElementById('user-info');
    const saveGameBtn = document.getElementById('save-game-btn');
    const coachBtn = document.getElementById('coach-toggle');

    if (user) {
      // User is signed in
      if (authContainer) authContainer.style.display = 'none';
      if (userInfo) {
        userInfo.innerHTML = `
          <span class="user-name">${user.displayName || user.email}</span>
          <button onclick="AuthModule.signOut()" class="auth-btn sign-out">Sign Out</button>
        `;
        userInfo.style.display = 'flex';
      }
      if (saveGameBtn) saveGameBtn.style.display = 'inline-block';
      if (coachBtn) coachBtn.style.display = 'inline-block';
    } else {
      // User is signed out
      if (authContainer) authContainer.style.display = 'flex';
      if (userInfo) userInfo.style.display = 'none';
      if (saveGameBtn) saveGameBtn.style.display = 'none';
      if (coachBtn) coachBtn.style.display = 'none';
    }
  },

  // Email auth modal functions
  isSignUpMode: false,

  showEmailAuthModal() {
    const modal = document.getElementById('email-auth-modal');
    if (modal) {
      modal.style.display = 'flex';
      this.isSignUpMode = false;
      this.updateAuthModalMode();
    }
  },

  closeEmailAuthModal() {
    const modal = document.getElementById('email-auth-modal');
    if (modal) {
      modal.style.display = 'none';
      // Clear inputs
      document.getElementById('auth-email').value = '';
      document.getElementById('auth-password').value = '';
      const errorEl = document.getElementById('auth-error');
      if (errorEl) errorEl.style.display = 'none';
    }
  },

  toggleAuthMode() {
    this.isSignUpMode = !this.isSignUpMode;
    this.updateAuthModalMode();
  },

  updateAuthModalMode() {
    const title = document.getElementById('auth-modal-title');
    const submitBtn = document.getElementById('auth-submit-btn');
    const toggleText = document.getElementById('auth-toggle-text');
    const toggleLink = document.getElementById('auth-toggle-link');

    if (this.isSignUpMode) {
      if (title) title.textContent = 'Create Account';
      if (submitBtn) submitBtn.textContent = 'Sign Up';
      if (toggleText) toggleText.textContent = 'Already have an account?';
      if (toggleLink) toggleLink.textContent = 'Sign In';
    } else {
      if (title) title.textContent = 'Sign In';
      if (submitBtn) submitBtn.textContent = 'Sign In';
      if (toggleText) toggleText.textContent = "Don't have an account?";
      if (toggleLink) toggleLink.textContent = 'Sign Up';
    }
  },

  handleEmailAuth() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;

    if (!email || !password) {
      this.showAuthError({ code: '', message: 'Please enter email and password' });
      return;
    }

    if (this.isSignUpMode) {
      this.signUpWithEmail(email, password);
    } else {
      this.signInWithEmail(email, password);
    }
  }
};

// Global functions for onclick handlers
function showEmailAuthModal() {
  AuthModule.showEmailAuthModal();
}

function closeEmailAuthModal() {
  AuthModule.closeEmailAuthModal();
}

function toggleAuthMode() {
  AuthModule.toggleAuthMode();
}

function handleEmailAuth() {
  AuthModule.handleEmailAuth();
}
