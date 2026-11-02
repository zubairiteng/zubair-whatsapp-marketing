import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, IsNumber, Min } from 'class-validator';

export class LoginDto {
  @IsNotEmpty({ message: 'Email or username is required' })
  @IsString()
  email!: string;

  @IsNotEmpty({ message: 'Password is required' })
  @IsString()
  password!: string;
}

export class CreateClientDto {
  @IsNotEmpty({ message: 'Name is required' })
  @IsString()
  name!: string;

  @IsNotEmpty({ message: 'Email is required' })
  @IsEmail({}, { message: 'A valid email address is required' })
  email!: string;

  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(6, { message: 'Password must be at least 6 characters' })
  password!: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  validityDays?: number;
}

export class UpdateClientDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  status?: 'active' | 'disabled';

  @IsOptional()
  @IsNumber()
  addDays?: number;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @MinLength(6)
  password?: string;
}
