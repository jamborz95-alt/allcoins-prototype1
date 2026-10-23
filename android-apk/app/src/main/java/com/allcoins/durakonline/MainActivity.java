package com.allcoins.durakonline;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    // Telegram has to open the Mini App so the backend can validate signed initData.
    private static final String TELEGRAM_GAME_LINK =
            "https://t.me/allcoins95_bot?startapp=apk";

    private final int navy = Color.rgb(8, 20, 35);
    private final int gold = Color.rgb(240, 210, 122);
    private final int cream = Color.rgb(255, 249, 232);
    private final int mint = Color.rgb(143, 245, 211);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(navy);
        getWindow().setNavigationBarColor(navy);
        showLauncher();
    }

    private void showLauncher() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setPadding(dp(26), dp(32), dp(26), dp(28));
        root.setBackground(new GradientDrawable(
                GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{Color.rgb(19, 52, 78), navy, Color.rgb(4, 12, 22)}));

        TextView suit = new TextView(this);
        suit.setText("♠  ♦  ♣  ♥");
        suit.setTextColor(gold);
        suit.setTextSize(24);
        suit.setGravity(Gravity.CENTER);
        suit.setLetterSpacing(0.08f);
        root.addView(suit, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        TextView brand = new TextView(this);
        brand.setText("ALLCOINS");
        brand.setTextColor(gold);
        brand.setTextSize(15);
        brand.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        brand.setGravity(Gravity.CENTER);
        brand.setLetterSpacing(0.22f);
        LinearLayout.LayoutParams brandParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(34));
        brandParams.topMargin = dp(10);
        root.addView(brand, brandParams);

        TextView title = new TextView(this);
        title.setText("ДУРАК ОНЛАЙН");
        title.setTextColor(cream);
        title.setTextSize(27);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        titleParams.topMargin = dp(6);
        root.addView(title, titleParams);

        TextView subtitle = new TextView(this);
        subtitle.setText("Карточная игра с друзьями");
        subtitle.setTextColor(mint);
        subtitle.setTextSize(15);
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subParams.topMargin = dp(12);
        root.addView(subtitle, subParams);

        TextView note = new TextView(this);
        note.setText("Для защищённого входа и онлайн-комнат игра открывается через Telegram.");
        note.setTextColor(Color.rgb(208, 220, 232));
        note.setTextSize(14);
        note.setGravity(Gravity.CENTER);
        note.setLineSpacing(dp(5), 1.0f);
        LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        noteParams.topMargin = dp(28);
        root.addView(note, noteParams);

        Button play = new Button(this);
        play.setText("ИГРАТЬ В TELEGRAM");
        play.setTextColor(Color.rgb(15, 32, 43));
        play.setTextSize(15);
        play.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        play.setAllCaps(false);
        GradientDrawable buttonBg = new GradientDrawable();
        buttonBg.setColor(gold);
        buttonBg.setCornerRadius(dp(16));
        play.setBackground(buttonBg);
        play.setPadding(dp(18), dp(8), dp(18), dp(8));
        LinearLayout.LayoutParams playParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(58));
        playParams.topMargin = dp(30);
        root.addView(play, playParams);
        play.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                openTelegramGame();
            }
        });

        TextView footer = new TextView(this);
        footer.setText("Интернет необходим");
        footer.setTextColor(Color.rgb(154, 173, 190));
        footer.setTextSize(12);
        footer.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams footerParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(38));
        footerParams.topMargin = dp(14);
        root.addView(footer, footerParams);
        setContentView(root);
    }

    private void openTelegramGame() {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(TELEGRAM_GAME_LINK));
            startActivity(intent);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this,
                    "Не удалось открыть Telegram. Установи Telegram и попробуй снова.",
                    Toast.LENGTH_LONG).show();
        }
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }
}
