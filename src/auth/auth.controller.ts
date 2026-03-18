import { BadRequestException, Body, Controller, Post, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { Public } from './public.decorator.js';

export class LoginDto {
  email!: string;
  password!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  async login(@Body() dto: LoginDto) {
    const { email, password } = dto;
    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }
    if (!this.authService.validateCredentials(email, password)) {
      throw new UnauthorizedException('Invalid email or password');
    }
    const accessToken = this.authService.createAccessToken(email);
    return { accessToken };
  }

  @Public()
  @Post('logout')
  async logout() {
    return { message: 'Logged out' };
  }
}
